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
import type Database from 'better-sqlite3';
import type { Task, TaskStatus } from '../types/index.js';
import type { TokenService } from '../token/index.js';
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
export declare class TaskManager {
    private queue;
    private db;
    private tokenService;
    private scannerTimer;
    constructor(db: Database.Database, tokenService: TokenService);
    /**
     * Create a new task, persist to SQLite (PENDING), add to memory queue.
     * Returns taskId, approvalLink, and expiresAt.
     */
    submit(payload: SubmitPayload): {
        taskId: string;
        approvalLink: string;
        expiresAt: number;
    };
    /**
     * Retrieve a task from the in-memory queue. Returns null if not found.
     */
    get(taskId: string): Task | null;
    /**
     * List all tasks in memory, optionally filtered by status.
     */
    list(status?: TaskStatus): Task[];
    /**
     * Approve a PENDING task → APPROVED, update SQLite, return Task.
     */
    approve(taskId: string): Task;
    /**
     * Reject a PENDING task → REJECTED, update SQLite, return Task.
     */
    reject(taskId: string): Task;
    /**
     * Mark an APPROVED task as complete (DONE / FAILED / TIMEOUT).
     * Updates SQLite with execution result details. Returns updated Task.
     */
    complete(taskId: string, result: TaskCompletionResult): Task;
    /**
     * Start the expiry scanner.
     * Scans every intervalMs (default 60 000 ms) and marks expired PENDING tasks as EXPIRED.
     */
    startExpiryScanner(intervalMs?: number): void;
    /**
     * Stop the expiry scanner.
     */
    stopExpiryScanner(): void;
    /**
     * On daemon restart: load all PENDING tasks from SQLite into memory queue.
     * Tasks that have already passed their expiresAt are immediately marked EXPIRED.
     */
    restore(): void;
    /** Expire all PENDING tasks whose expiresAt has passed. */
    private _expireStale;
    private _requireTask;
    private _assertState;
    private _rowToTask;
}
//# sourceMappingURL=index.d.ts.map