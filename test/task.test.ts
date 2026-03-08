/**
 * Unit tests for TaskManager (C4) - src/task/index.ts
 *
 * Tests the TokenService-based TaskManager with the full public API:
 *   submit / get / list / approve / reject / complete /
 *   startExpiryScanner / stopExpiryScanner / restore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TaskManager, type SubmitPayload, type TaskCompletionResult } from '../src/task/index.js';
import type { TokenService, GenerateResult } from '../src/token/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create an in-memory SQLite DB with the tasks schema */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id          TEXT PRIMARY KEY,
      command          TEXT NOT NULL,
      description      TEXT NOT NULL,
      risk_hint        TEXT,
      agent_session_id TEXT NOT NULL,
      submitted_at     INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      timeout_sec      INTEGER NOT NULL DEFAULT 300,
      status           TEXT NOT NULL DEFAULT 'PENDING',
      approved_at      INTEGER,
      completed_at     INTEGER,
      exit_code        INTEGER,
      stdout_snippet   TEXT,
      stderr_snippet   TEXT,
      log_file         TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );
  `);
  return db;
}

/** Create a minimal mock TokenService */
function makeTokenService(): TokenService {
  return {
    generate: vi.fn((_taskId: string, _command: string, _expiresAt: number): GenerateResult => ({
      token: 'mock-token',
      approvalUrl: `https://approval.example.com/approve?task_id=${_taskId}&token=mock-token`,
    })),
    verify: vi.fn(),
    consume: vi.fn(),
    loadConsumed: vi.fn(),
    scheduleCleanup: vi.fn(),
    stopCleanup: vi.fn(),
  } as unknown as TokenService;
}

const basePayload: SubmitPayload = {
  command: 'echo hello',
  description: 'test task',
  agentSessionId: 'session-abc',
  expiresInSec: 300,
  timeoutSec: 60,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskManager (C4)', () => {
  let db: Database.Database;
  let tokenService: TokenService;
  let tm: TaskManager;

  beforeEach(() => {
    db = makeDb();
    tokenService = makeTokenService();
    tm = new TaskManager(db, tokenService);
  });

  afterEach(() => {
    tm.stopExpiryScanner();
    db.close();
  });

  // ── submit ─────────────────────────────────────────────────────────────────

  describe('submit()', () => {
    it('returns taskId, approvalLink, and expiresAt', () => {
      const result = tm.submit(basePayload);
      expect(result.taskId).toBeTruthy();
      expect(result.approvalLink).toContain('https://');
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('calls tokenService.generate with correct args', () => {
      const result = tm.submit(basePayload);
      expect(tokenService.generate).toHaveBeenCalledWith(
        result.taskId,
        basePayload.command,
        result.expiresAt,
      );
    });

    it('adds task to in-memory queue with PENDING status', () => {
      const { taskId } = tm.submit(basePayload);
      const task = tm.get(taskId);
      expect(task).not.toBeNull();
      expect(task!.status).toBe('PENDING');
      expect(task!.command).toBe('echo hello');
    });

    it('persists to SQLite', () => {
      const { taskId } = tm.submit(basePayload);
      const row = db
        .prepare('SELECT * FROM tasks WHERE task_id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row['status']).toBe('PENDING');
    });

    it('generates unique taskIds', () => {
      const r1 = tm.submit(basePayload);
      const r2 = tm.submit(basePayload);
      expect(r1.taskId).not.toBe(r2.taskId);
    });

    it('does not throw when SQLite is closed (degrades to memory-only)', () => {
      db.close();
      expect(() => {
        const { taskId } = tm.submit(basePayload);
        expect(tm.get(taskId)).not.toBeNull();
      }).not.toThrow();
    });
  });

  // ── get ────────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns null for unknown taskId', () => {
      expect(tm.get('no-such-id')).toBeNull();
    });

    it('returns task after submit', () => {
      const { taskId } = tm.submit(basePayload);
      expect(tm.get(taskId)).not.toBeNull();
    });
  });

  // ── list ───────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns all tasks when no status filter', () => {
      tm.submit(basePayload);
      tm.submit(basePayload);
      expect(tm.list()).toHaveLength(2);
    });

    it('filters by status', () => {
      const { taskId } = tm.submit(basePayload);
      tm.submit(basePayload);
      tm.approve(taskId);
      expect(tm.list('PENDING')).toHaveLength(1);
      expect(tm.list('APPROVED')).toHaveLength(1);
    });

    it('returns empty array when no tasks', () => {
      expect(tm.list()).toHaveLength(0);
    });
  });

  // ── approve ────────────────────────────────────────────────────────────────

  describe('approve()', () => {
    it('transitions PENDING → APPROVED and returns Task', () => {
      const { taskId } = tm.submit(basePayload);
      const task = tm.approve(taskId);
      expect(task.status).toBe('APPROVED');
      expect(task.approvedAt).toBeTypeOf('number');
    });

    it('updates SQLite', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      const row = db
        .prepare('SELECT status, approved_at FROM tasks WHERE task_id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row['status']).toBe('APPROVED');
      expect(row['approved_at']).toBeTypeOf('number');
    });

    it('throws if task is not PENDING', () => {
      const { taskId } = tm.submit(basePayload);
      tm.reject(taskId);
      expect(() => tm.approve(taskId)).toThrow(/REJECTED/);
    });

    it('throws for unknown taskId', () => {
      expect(() => tm.approve('bad-id')).toThrow(/not found/i);
    });
  });

  // ── reject ─────────────────────────────────────────────────────────────────

  describe('reject()', () => {
    it('transitions PENDING → REJECTED and returns Task', () => {
      const { taskId } = tm.submit(basePayload);
      const task = tm.reject(taskId);
      expect(task.status).toBe('REJECTED');
      expect(task.completedAt).toBeTypeOf('number');
    });

    it('updates SQLite', () => {
      const { taskId } = tm.submit(basePayload);
      tm.reject(taskId);
      const row = db
        .prepare('SELECT status FROM tasks WHERE task_id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row['status']).toBe('REJECTED');
    });

    it('throws if not PENDING', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      expect(() => tm.reject(taskId)).toThrow(/APPROVED/);
    });
  });

  // ── complete ───────────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('transitions APPROVED → DONE and returns Task with result', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      const result: TaskCompletionResult = {
        status: 'DONE',
        exitCode: 0,
        stdoutSnippet: 'hello',
        stderrSnippet: '',
      };
      const task = tm.complete(taskId, result);
      expect(task.status).toBe('DONE');
      expect(task.exitCode).toBe(0);
      expect(task.stdoutSnippet).toBe('hello');
    });

    it('transitions APPROVED → FAILED', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      const task = tm.complete(taskId, { status: 'FAILED', exitCode: 1 });
      expect(task.status).toBe('FAILED');
    });

    it('transitions APPROVED → TIMEOUT', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      const task = tm.complete(taskId, { status: 'TIMEOUT' });
      expect(task.status).toBe('TIMEOUT');
    });

    it('updates SQLite with all result fields', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      tm.complete(taskId, {
        status: 'DONE',
        exitCode: 0,
        stdoutSnippet: 'out',
        stderrSnippet: 'err',
      });
      const row = db
        .prepare('SELECT * FROM tasks WHERE task_id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row['status']).toBe('DONE');
      expect(row['exit_code']).toBe(0);
      expect(row['stdout_snippet']).toBe('out');
      expect(row['stderr_snippet']).toBe('err');
      expect(row['completed_at']).toBeTypeOf('number');
    });

    it('throws if task is not APPROVED (PENDING)', () => {
      const { taskId } = tm.submit(basePayload);
      expect(() => tm.complete(taskId, { status: 'DONE' })).toThrow(/PENDING/);
    });

    it('throws if task is already DONE (double complete)', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      tm.complete(taskId, { status: 'DONE', exitCode: 0 });
      expect(() => tm.complete(taskId, { status: 'DONE' })).toThrow(/DONE/);
    });
  });

  // ── Illegal state transitions ──────────────────────────────────────────────

  describe('illegal state transitions', () => {
    it('DONE → approve should throw', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      tm.complete(taskId, { status: 'DONE' });
      expect(() => tm.approve(taskId)).toThrow();
    });

    it('REJECTED → complete should throw', () => {
      const { taskId } = tm.submit(basePayload);
      tm.reject(taskId);
      expect(() => tm.complete(taskId, { status: 'DONE' })).toThrow();
    });

    it('EXPIRED → approve should throw', () => {
      const { taskId } = tm.submit({ ...basePayload, expiresInSec: -1 });
      // Manually expire it
      const task = tm.get(taskId)!;
      // Force expiry via restore (simulate time passing)
      db.prepare(`UPDATE tasks SET expires_at = 1 WHERE task_id = ?`).run(taskId);
      // Use a fresh TM to restore which will expire it
      const tm2 = new TaskManager(db, tokenService);
      tm2.restore();
      // task expired via restore
      const expiredTask = tm2.get(taskId);
      expect(expiredTask).toBeNull(); // it was expired and not added to queue
      // Try approving via original TM (task still in queue as EXPIRED after manual set)
      task.status = 'EXPIRED';
      expect(() => tm.approve(taskId)).toThrow();
    });
  });

  // ── restore ────────────────────────────────────────────────────────────────

  describe('restore()', () => {
    it('restores PENDING tasks from SQLite into memory queue', () => {
      const { taskId } = tm.submit(basePayload);
      // Simulate restart: new TaskManager, same DB
      const tm2 = new TaskManager(db, tokenService);
      tm2.restore();
      expect(tm2.get(taskId)).not.toBeNull();
      expect(tm2.get(taskId)!.status).toBe('PENDING');
    });

    it('does not restore non-PENDING tasks', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      tm.complete(taskId, { status: 'DONE', exitCode: 0 });

      const tm2 = new TaskManager(db, tokenService);
      tm2.restore();
      expect(tm2.get(taskId)).toBeNull();
    });

    it('marks already-expired PENDING tasks as EXPIRED in SQLite', () => {
      const { taskId } = tm.submit(basePayload);
      // Force expiresAt to the past in SQLite
      db.prepare(`UPDATE tasks SET expires_at = 1 WHERE task_id = ?`).run(taskId);

      const tm2 = new TaskManager(db, tokenService);
      tm2.restore();

      // Should not be in memory queue
      expect(tm2.get(taskId)).toBeNull();

      // Should be EXPIRED in SQLite
      const row = db
        .prepare('SELECT status FROM tasks WHERE task_id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row['status']).toBe('EXPIRED');
    });

    it('restored tasks can be approved', () => {
      const { taskId } = tm.submit(basePayload);

      const tm2 = new TaskManager(db, tokenService);
      tm2.restore();
      const task = tm2.approve(taskId);
      expect(task.status).toBe('APPROVED');
    });

    it('returns without error on empty DB', () => {
      const tm2 = new TaskManager(db, tokenService);
      expect(() => tm2.restore()).not.toThrow();
    });
  });

  // ── startExpiryScanner / stopExpiryScanner ─────────────────────────────────

  describe('expiry scanner', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('expires PENDING tasks after interval', () => {
      // Submit a task that expires in 50ms
      const { taskId } = tm.submit({ ...basePayload, expiresInSec: 0 });
      // Start scanner with 100ms interval
      tm.startExpiryScanner(100);

      // Advance time past expiry
      vi.advanceTimersByTime(150);

      expect(tm.get(taskId)!.status).toBe('EXPIRED');
    });

    it('does not expire tasks before their time', () => {
      const { taskId } = tm.submit({ ...basePayload, expiresInSec: 3600 });
      tm.startExpiryScanner(100);
      vi.advanceTimersByTime(200);
      expect(tm.get(taskId)!.status).toBe('PENDING');
    });

    it('stopExpiryScanner prevents further scanning', () => {
      const { taskId } = tm.submit({ ...basePayload, expiresInSec: 0 });
      tm.startExpiryScanner(100);
      tm.stopExpiryScanner();
      vi.advanceTimersByTime(200);
      // Should still be PENDING since scanner was stopped before first tick
      expect(tm.get(taskId)!.status).toBe('PENDING');
    });

    it('calling startExpiryScanner twice does not create duplicate timers', () => {
      tm.startExpiryScanner(100);
      tm.startExpiryScanner(100); // should be a no-op
      // No assertion needed beyond "no error", but we verify scan still works
      const { taskId } = tm.submit({ ...basePayload, expiresInSec: 0 });
      vi.advanceTimersByTime(150);
      expect(tm.get(taskId)!.status).toBe('EXPIRED');
    });

    it('updates SQLite when expiring via scanner', () => {
      const { taskId } = tm.submit({ ...basePayload, expiresInSec: 0 });
      tm.startExpiryScanner(100);
      vi.advanceTimersByTime(150);

      const row = db
        .prepare('SELECT status FROM tasks WHERE task_id = ?')
        .get(taskId) as Record<string, unknown>;
      expect(row['status']).toBe('EXPIRED');
    });
  });

  // ── SQLite degraded mode ───────────────────────────────────────────────────

  describe('SQLite write failure (degraded mode)', () => {
    it('approve succeeds even if DB is closed — memory state is consistent', () => {
      const { taskId } = tm.submit(basePayload);
      db.close();
      // Should not throw; memory state updated
      expect(() => {
        const task = tm.approve(taskId);
        expect(task.status).toBe('APPROVED');
      }).not.toThrow();
    });

    it('reject succeeds even if DB is closed', () => {
      const { taskId } = tm.submit(basePayload);
      db.close();
      expect(() => {
        const task = tm.reject(taskId);
        expect(task.status).toBe('REJECTED');
      }).not.toThrow();
    });

    it('complete succeeds even if DB is closed', () => {
      const { taskId } = tm.submit(basePayload);
      tm.approve(taskId);
      db.close();
      expect(() => {
        const task = tm.complete(taskId, { status: 'DONE', exitCode: 0 });
        expect(task.status).toBe('DONE');
      }).not.toThrow();
    });
  });
});
