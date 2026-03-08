/**
 * Task Manager - C4 Component
 *
 * Manages in-memory task queue with SQLite persistence.
 * Handles task lifecycle state machine:
 *   PENDING → APPROVED / REJECTED / EXPIRED
 *   APPROVED → DONE / FAILED / TIMEOUT
 */
import Database from 'better-sqlite3';
import type { Task, SubmitTaskPayload } from '../types/index.js';
/** Callback invoked after a task is approved, to trigger execution */
export type ExecutorCallback = (task: Task) => void;
/** Completion result passed to complete() */
export interface CompletionResult {
    status: 'DONE' | 'FAILED' | 'TIMEOUT';
    exitCode?: number | null;
    stdoutSnippet?: string | null;
    stderrSnippet?: string | null;
    logFile?: string | null;
}
export declare class TaskManager {
    private queue;
    private db;
    private onExecute;
    constructor(db: Database.Database, onExecute: ExecutorCallback);
    /**
     * Create a new task, persist to SQLite (PENDING), add to memory queue.
     * Returns the new taskId.
     */
    submit(payload: SubmitTaskPayload): string;
    /**
     * Retrieve a task from the in-memory queue.
     * Returns null if not found.
     */
    get(taskId: string): Task | null;
    /**
     * Approve a PENDING task → APPROVED, update SQLite, invoke executor callback.
     */
    approve(taskId: string): void;
    /**
     * Reject a PENDING task → REJECTED, update SQLite.
     */
    reject(taskId: string): void;
    /**
     * Mark an APPROVED task as complete (DONE / FAILED / TIMEOUT).
     * Updates SQLite with execution result details.
     */
    complete(taskId: string, result: CompletionResult): void;
    /**
     * Scan all PENDING tasks and expire those whose expiresAt has passed.
     */
    expireStale(): number;
    /**
     * On daemon restart: load all PENDING tasks from SQLite into memory queue.
     * Non-PENDING tasks are not restored (they are terminal or already executing).
     */
    restore(): number;
    private _requireTask;
    private _assertState;
    private _rowToTask;
}
//# sourceMappingURL=manager.d.ts.map