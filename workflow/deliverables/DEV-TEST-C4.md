# DEV-TEST-C4: Task Manager 自验证报告

**组件:** C4 - 任务队列 & 生命周期（Task Manager）  
**文件:** `src/task/manager.ts`  
**测试:** `test/task-manager.test.ts`  
**日期:** 2026-03-08  
**状态:** ✅ 自验证通过

---

## 自验证结果

### 编译验证
```
npm run build → 0 errors, 0 warnings
```

### 测试验证
```
npx vitest run test/task-manager.test.ts

 Test Files  1 passed (1)
      Tests  29 passed (29)
   Duration  665ms
```

全部 29 个测试通过，覆盖：`submit`、`get`、`approve`、`reject`、`complete`、`expireStale`、`restore`、降级模式、非法状态转换。

---

## 实现说明

### 核心设计

**状态机约束**  
通过 `_assertState(task, expected, action)` 强制状态前置检查，非法跳转立即抛出带明确错误信息的 `Error`。合法流转：
- `PENDING → APPROVED`（approve）
- `PENDING → REJECTED`（reject）
- `PENDING → EXPIRED`（expireStale）
- `APPROVED → DONE / FAILED / TIMEOUT`（complete）

**SQLite 降级可接受**  
所有 DB 写操作包裹在 `try/catch` 中，失败时记录 WARN 日志但不抛出。内存状态始终先行更新，确保运行时不受 DB 故障影响（满足验收标准）。

**Executor Callback 解耦**  
`approve()` 在更新内存+DB 后，通过构造时注入的 `ExecutorCallback` 触发命令执行，TaskManager 本身不含任何执行逻辑（边界清晰）。

**restore() 仅恢复 PENDING**  
重启时只恢复 `status = 'PENDING'` 的任务到内存队列。APPROVED/DONE 等状态的任务属于历史记录，不需要恢复到内存（已执行完或正在执行中重启时属异常，不在此组件处理范围内）。

**expiresInSec 默认值**  
`submit()` 中 `expiresInSec` 默认 300 秒，`timeoutSec` 默认 300 秒，与数据库 schema 中 `DEFAULT 300` 保持一致。

### 已知限制

1. **并发安全**：当前实现基于单线程 Node.js 事件循环，无锁保护。若未来引入 Worker Threads 或多进程，需要加互斥逻辑。
2. **restore() 不恢复 APPROVED 任务**：daemon 崩溃时正在执行的任务（APPROVED 状态）重启后无法自动重新执行，需上层逻辑处理（超出 C4 边界）。
3. **内存无上限**：队列为无限 `Map`，高频提交场景建议上层控制并发量。

---

## 接口摘要

| 方法 | 签名 | 说明 |
|------|------|------|
| `submit` | `(payload: SubmitTaskPayload) => string` | 创建任务，返回 taskId |
| `get` | `(taskId: string) => Task \| null` | 查询内存任务 |
| `approve` | `(taskId: string) => void` | PENDING→APPROVED，触发 Executor |
| `reject` | `(taskId: string) => void` | PENDING→REJECTED |
| `complete` | `(taskId: string, result: CompletionResult) => void` | APPROVED→终态 |
| `expireStale` | `() => number` | 扫描过期任务，返回过期数量 |
| `restore` | `() => number` | 从 SQLite 恢复 PENDING 任务 |
