/**
 * Task Manager - src/task/index.ts
 *
 * Manages in-memory task queue with SQLite persistence.
 * Handles task lifecycle state machine:
 *   PENDING → APPROVED / REJECTED / EXPIRED
 *   APPROVED → DONE / FAILED / TIMEOUT
 *
 * Constructor takes a TokenService to generate approval links.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger/index.js';
const log = createLogger('task-manager');
// ── TaskManager ───────────────────────────────────────────────────────────────
export class TaskManager {
    queue = new Map();
    db;
    tokenService;
    scannerTimer = null;
    constructor(db, tokenService) {
        this.db = db;
        this.tokenService = tokenService;
    }
    /**
     * Create a new task, persist to SQLite (PENDING), add to memory queue.
     * Returns taskId, approvalLink, and expiresAt.
     */
    submit(payload) {
        const taskId = randomUUID();
        const now = Date.now();
        const expiresInSec = payload.expiresInSec ?? 86400; // default 24h — Boss may be asleep
        const timeoutSec = payload.timeoutSec ?? 86400;
        const expiresAt = now + expiresInSec * 1000;
        // Generate approval token and link
        const { approvalUrl: approvalLink } = this.tokenService.generate(taskId, payload.command, expiresAt);
        const task = {
            taskId,
            command: payload.command,
            description: payload.description,
            riskHint: payload.riskHint ?? null,
            agentSessionId: payload.agentSessionId,
            submittedAt: now,
            expiresAt,
            timeoutSec,
            status: 'PENDING',
            approvedAt: null,
            completedAt: null,
            exitCode: null,
            stdoutSnippet: null,
            stderrSnippet: null,
            logFile: null,
            createdAt: now,
        };
        // Persist to SQLite (failures are non-fatal — degrade gracefully)
        try {
            this.db
                .prepare(`INSERT INTO tasks (
            task_id, command, description, risk_hint, agent_session_id,
            submitted_at, expires_at, timeout_sec, status, created_at
          ) VALUES (
            @taskId, @command, @description, @riskHint, @agentSessionId,
            @submittedAt, @expiresAt, @timeoutSec, @status, @createdAt
          )`)
                .run({
                taskId,
                command: task.command,
                description: task.description,
                riskHint: task.riskHint ?? null,
                agentSessionId: task.agentSessionId,
                submittedAt: task.submittedAt,
                expiresAt: task.expiresAt,
                timeoutSec: task.timeoutSec,
                status: task.status,
                createdAt: task.createdAt,
            });
        }
        catch (err) {
            log.warn({ err, taskId }, 'SQLite INSERT failed; task kept in memory only');
        }
        this.queue.set(taskId, task);
        log.info({ taskId, command: task.command }, 'Task submitted');
        return { taskId, approvalLink, expiresAt };
    }
    /**
     * Retrieve a task from the in-memory queue. Returns null if not found.
     */
    get(taskId) {
        return this.queue.get(taskId) ?? null;
    }
    /**
     * List all tasks in memory, optionally filtered by status.
     */
    list(status) {
        const tasks = Array.from(this.queue.values());
        if (status === undefined)
            return tasks;
        return tasks.filter((t) => t.status === status);
    }
    /**
     * Approve a PENDING task → APPROVED, update SQLite, return Task.
     */
    approve(taskId) {
        const task = this._requireTask(taskId);
        this._assertState(task, ['PENDING'], 'approve');
        const now = Date.now();
        task.status = 'APPROVED';
        task.approvedAt = now;
        try {
            this.db
                .prepare(`UPDATE tasks SET status = 'APPROVED', approved_at = ? WHERE task_id = ?`)
                .run(now, taskId);
        }
        catch (err) {
            log.warn({ err, taskId }, 'SQLite UPDATE failed on approve');
        }
        log.info({ taskId }, 'Task approved');
        return task;
    }
    /**
     * Reject a PENDING task → REJECTED, update SQLite, return Task.
     */
    reject(taskId) {
        const task = this._requireTask(taskId);
        this._assertState(task, ['PENDING'], 'reject');
        const now = Date.now();
        task.status = 'REJECTED';
        task.completedAt = now;
        try {
            this.db
                .prepare(`UPDATE tasks SET status = 'REJECTED', completed_at = ? WHERE task_id = ?`)
                .run(now, taskId);
        }
        catch (err) {
            log.warn({ err, taskId }, 'SQLite UPDATE failed on reject');
        }
        log.info({ taskId }, 'Task rejected');
        return task;
    }
    /**
     * Mark an APPROVED task as complete (DONE / FAILED / TIMEOUT).
     * Updates SQLite with execution result details. Returns updated Task.
     */
    complete(taskId, result) {
        const task = this._requireTask(taskId);
        this._assertState(task, ['APPROVED'], 'complete');
        const now = Date.now();
        task.status = result.status;
        task.completedAt = now;
        task.exitCode = result.exitCode ?? null;
        task.stdoutSnippet = result.stdoutSnippet ?? null;
        task.stderrSnippet = result.stderrSnippet ?? null;
        task.logFile = result.logFile ?? null;
        try {
            this.db
                .prepare(`UPDATE tasks
           SET status = ?, completed_at = ?, exit_code = ?,
               stdout_snippet = ?, stderr_snippet = ?, log_file = ?
           WHERE task_id = ?`)
                .run(task.status, now, task.exitCode ?? null, task.stdoutSnippet ?? null, task.stderrSnippet ?? null, task.logFile ?? null, taskId);
        }
        catch (err) {
            log.warn({ err, taskId }, 'SQLite UPDATE failed on complete');
        }
        log.info({ taskId, status: task.status }, 'Task completed');
        return task;
    }
    /**
     * Start the expiry scanner.
     * Scans every intervalMs (default 60 000 ms) and marks expired PENDING tasks as EXPIRED.
     */
    startExpiryScanner(intervalMs = 60_000) {
        if (this.scannerTimer)
            return; // already running
        this.scannerTimer = setInterval(() => {
            this._expireStale();
        }, intervalMs);
        // Unref so the timer doesn't prevent process exit
        if (this.scannerTimer.unref) {
            this.scannerTimer.unref();
        }
        log.info({ intervalMs }, 'Expiry scanner started');
    }
    /**
     * Stop the expiry scanner.
     */
    stopExpiryScanner() {
        if (this.scannerTimer) {
            clearInterval(this.scannerTimer);
            this.scannerTimer = null;
            log.info('Expiry scanner stopped');
        }
    }
    /**
     * On daemon restart: load all PENDING tasks from SQLite into memory queue.
     * Tasks that have already passed their expiresAt are immediately marked EXPIRED.
     */
    restore() {
        try {
            const rows = this.db
                .prepare(`SELECT * FROM tasks WHERE status = 'PENDING'`)
                .all();
            const now = Date.now();
            let restored = 0;
            let expired = 0;
            for (const row of rows) {
                const task = this._rowToTask(row);
                if (task.expiresAt < now) {
                    // Already past expiry — mark as EXPIRED in SQLite (best effort)
                    task.status = 'EXPIRED';
                    task.completedAt = now;
                    try {
                        this.db
                            .prepare(`UPDATE tasks SET status = 'EXPIRED', completed_at = ? WHERE task_id = ?`)
                            .run(now, task.taskId);
                    }
                    catch (err) {
                        log.warn({ err, taskId: task.taskId }, 'SQLite UPDATE failed on restore-expire');
                    }
                    expired++;
                }
                else {
                    this.queue.set(task.taskId, task);
                    restored++;
                }
            }
            log.info({ restored, expired }, 'Tasks restored from SQLite');
        }
        catch (err) {
            log.error({ err }, 'Failed to restore tasks from SQLite');
        }
    }
    // ── Private Helpers ────────────────────────────────────────────────────────
    /** Expire all PENDING tasks whose expiresAt has passed. */
    _expireStale() {
        const now = Date.now();
        let expired = 0;
        for (const [taskId, task] of this.queue) {
            if (task.status === 'PENDING' && task.expiresAt < now) {
                task.status = 'EXPIRED';
                task.completedAt = now;
                expired++;
                try {
                    this.db
                        .prepare(`UPDATE tasks SET status = 'EXPIRED', completed_at = ? WHERE task_id = ?`)
                        .run(now, taskId);
                }
                catch (err) {
                    log.warn({ err, taskId }, 'SQLite UPDATE failed on expire');
                }
                log.info({ taskId }, 'Task expired');
            }
        }
        if (expired > 0) {
            log.info({ expired }, 'Stale tasks expired');
        }
    }
    _requireTask(taskId) {
        const task = this.queue.get(taskId);
        if (!task) {
            throw new Error(`Task not found: ${taskId}`);
        }
        return task;
    }
    _assertState(task, allowed, action) {
        if (!allowed.includes(task.status)) {
            throw new Error(`Cannot ${action} task ${task.taskId}: expected status in [${allowed.join(', ')}], got ${task.status}`);
        }
    }
    _rowToTask(row) {
        return {
            taskId: row['task_id'],
            command: row['command'],
            description: row['description'],
            riskHint: row['risk_hint'] ?? null,
            agentSessionId: row['agent_session_id'],
            submittedAt: row['submitted_at'],
            expiresAt: row['expires_at'],
            timeoutSec: row['timeout_sec'],
            status: row['status'],
            approvedAt: row['approved_at'] ?? null,
            completedAt: row['completed_at'] ?? null,
            exitCode: row['exit_code'] ?? null,
            stdoutSnippet: row['stdout_snippet'] ?? null,
            stderrSnippet: row['stderr_snippet'] ?? null,
            logFile: row['log_file'] ?? null,
            createdAt: row['created_at'],
        };
    }
}
//# sourceMappingURL=index.js.map