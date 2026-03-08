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
import type Database from 'better-sqlite3';
import { createLogger } from '../logger/index.js';
import type { Task, TaskStatus } from '../types/index.js';
import type { TokenService } from '../token/index.js';

const log = createLogger('task-manager');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubmitPayload {
  command: string;
  description: string;
  riskHint?: string;
  agentSessionId: string;
  timeoutSec?: number;
  expiresInSec?: number;
}

export interface TaskCompletionResult {
  status: 'DONE' | 'FAILED' | 'TIMEOUT';
  exitCode?: number | null;
  stdoutSnippet?: string | null;
  stderrSnippet?: string | null;
  logFile?: string | null;
}

// ── TaskManager ───────────────────────────────────────────────────────────────

export class TaskManager {
  private queue: Map<string, Task> = new Map();
  private db: Database.Database;
  private tokenService: TokenService;
  private scannerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database.Database, tokenService: TokenService) {
    this.db = db;
    this.tokenService = tokenService;
  }

  /**
   * Create a new task, persist to SQLite (PENDING), add to memory queue.
   * Returns taskId, approvalLink, and expiresAt.
   */
  submit(payload: SubmitPayload): { taskId: string; approvalLink: string; expiresAt: number } {
    const taskId = randomUUID();
    const now = Date.now();
    const expiresInSec = payload.expiresInSec ?? 300;
    const timeoutSec = payload.timeoutSec ?? 300;
    const expiresAt = now + expiresInSec * 1000;

    // Generate approval token and link
    const { approvalUrl: approvalLink } = this.tokenService.generate(
      taskId,
      payload.command,
      expiresAt,
    );

    const task: Task = {
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
        .prepare(
          `INSERT INTO tasks (
            task_id, command, description, risk_hint, agent_session_id,
            submitted_at, expires_at, timeout_sec, status, created_at
          ) VALUES (
            @taskId, @command, @description, @riskHint, @agentSessionId,
            @submittedAt, @expiresAt, @timeoutSec, @status, @createdAt
          )`,
        )
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
    } catch (err) {
      log.warn({ err, taskId }, 'SQLite INSERT failed; task kept in memory only');
    }

    this.queue.set(taskId, task);
    log.info({ taskId, command: task.command }, 'Task submitted');

    return { taskId, approvalLink, expiresAt };
  }

  /**
   * Retrieve a task from the in-memory queue. Returns null if not found.
   */
  get(taskId: string): Task | null {
    return this.queue.get(taskId) ?? null;
  }

  /**
   * List all tasks in memory, optionally filtered by status.
   */
  list(status?: TaskStatus): Task[] {
    const tasks = Array.from(this.queue.values());
    if (status === undefined) return tasks;
    return tasks.filter((t) => t.status === status);
  }

  /**
   * Approve a PENDING task → APPROVED, update SQLite, return Task.
   */
  approve(taskId: string): Task {
    const task = this._requireTask(taskId);
    this._assertState(task, ['PENDING'], 'approve');

    const now = Date.now();
    task.status = 'APPROVED';
    task.approvedAt = now;

    try {
      this.db
        .prepare(`UPDATE tasks SET status = 'APPROVED', approved_at = ? WHERE task_id = ?`)
        .run(now, taskId);
    } catch (err) {
      log.warn({ err, taskId }, 'SQLite UPDATE failed on approve');
    }

    log.info({ taskId }, 'Task approved');
    return task;
  }

  /**
   * Reject a PENDING task → REJECTED, update SQLite, return Task.
   */
  reject(taskId: string): Task {
    const task = this._requireTask(taskId);
    this._assertState(task, ['PENDING'], 'reject');

    const now = Date.now();
    task.status = 'REJECTED';
    task.completedAt = now;

    try {
      this.db
        .prepare(`UPDATE tasks SET status = 'REJECTED', completed_at = ? WHERE task_id = ?`)
        .run(now, taskId);
    } catch (err) {
      log.warn({ err, taskId }, 'SQLite UPDATE failed on reject');
    }

    log.info({ taskId }, 'Task rejected');
    return task;
  }

  /**
   * Mark an APPROVED task as complete (DONE / FAILED / TIMEOUT).
   * Updates SQLite with execution result details. Returns updated Task.
   */
  complete(taskId: string, result: TaskCompletionResult): Task {
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
        .prepare(
          `UPDATE tasks
           SET status = ?, completed_at = ?, exit_code = ?,
               stdout_snippet = ?, stderr_snippet = ?, log_file = ?
           WHERE task_id = ?`,
        )
        .run(
          task.status,
          now,
          task.exitCode ?? null,
          task.stdoutSnippet ?? null,
          task.stderrSnippet ?? null,
          task.logFile ?? null,
          taskId,
        );
    } catch (err) {
      log.warn({ err, taskId }, 'SQLite UPDATE failed on complete');
    }

    log.info({ taskId, status: task.status }, 'Task completed');
    return task;
  }

  /**
   * Start the expiry scanner.
   * Scans every intervalMs (default 60 000 ms) and marks expired PENDING tasks as EXPIRED.
   */
  startExpiryScanner(intervalMs = 60_000): void {
    if (this.scannerTimer) return; // already running

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
  stopExpiryScanner(): void {
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
  restore(): void {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM tasks WHERE status = 'PENDING'`)
        .all() as Array<Record<string, unknown>>;

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
              .prepare(
                `UPDATE tasks SET status = 'EXPIRED', completed_at = ? WHERE task_id = ?`,
              )
              .run(now, task.taskId);
          } catch (err) {
            log.warn({ err, taskId: task.taskId }, 'SQLite UPDATE failed on restore-expire');
          }
          expired++;
        } else {
          this.queue.set(task.taskId, task);
          restored++;
        }
      }

      log.info({ restored, expired }, 'Tasks restored from SQLite');
    } catch (err) {
      log.error({ err }, 'Failed to restore tasks from SQLite');
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /** Expire all PENDING tasks whose expiresAt has passed. */
  private _expireStale(): void {
    const now = Date.now();
    let expired = 0;

    for (const [taskId, task] of this.queue) {
      if (task.status === 'PENDING' && task.expiresAt < now) {
        task.status = 'EXPIRED';
        task.completedAt = now;
        expired++;

        try {
          this.db
            .prepare(
              `UPDATE tasks SET status = 'EXPIRED', completed_at = ? WHERE task_id = ?`,
            )
            .run(now, taskId);
        } catch (err) {
          log.warn({ err, taskId }, 'SQLite UPDATE failed on expire');
        }

        log.info({ taskId }, 'Task expired');
      }
    }

    if (expired > 0) {
      log.info({ expired }, 'Stale tasks expired');
    }
  }

  private _requireTask(taskId: string): Task {
    const task = this.queue.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private _assertState(task: Task, allowed: TaskStatus[], action: string): void {
    if (!allowed.includes(task.status)) {
      throw new Error(
        `Cannot ${action} task ${task.taskId}: expected status in [${allowed.join(', ')}], got ${task.status}`,
      );
    }
  }

  private _rowToTask(row: Record<string, unknown>): Task {
    return {
      taskId: row['task_id'] as string,
      command: row['command'] as string,
      description: row['description'] as string,
      riskHint: (row['risk_hint'] as string | null) ?? null,
      agentSessionId: row['agent_session_id'] as string,
      submittedAt: row['submitted_at'] as number,
      expiresAt: row['expires_at'] as number,
      timeoutSec: row['timeout_sec'] as number,
      status: row['status'] as TaskStatus,
      approvedAt: (row['approved_at'] as number | null) ?? null,
      completedAt: (row['completed_at'] as number | null) ?? null,
      exitCode: (row['exit_code'] as number | null) ?? null,
      stdoutSnippet: (row['stdout_snippet'] as string | null) ?? null,
      stderrSnippet: (row['stderr_snippet'] as string | null) ?? null,
      logFile: (row['log_file'] as string | null) ?? null,
      createdAt: row['created_at'] as number,
    };
  }
}
