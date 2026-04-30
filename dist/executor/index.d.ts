/**
 * Executor - C5 Component
 *
 * Responsibilities:
 *   - fork/execve child process (no shell for single commands)
 *   - Capture stdout/stderr via PassThrough → gzip → log file
 *   - Enforce timeout watchdog (SIGTERM → 5s → SIGKILL)
 *   - Collect first 4KB snippets of stdout/stderr
 *   - Call TaskManager.complete() when done
 *   - TODO (C6): trigger Notifier.notify()
 */
import type { Task } from '../types/index.js';
import type { TaskManager } from '../task/index.js';
import type { Notifier } from '../notifier/index.js';
export interface ExecutorOptions {
    /** Override log directory root (useful for tests). Default: /var/log/root-daemon */
    logBase?: string;
    /** Notifier instance for C5→C6 result delivery (optional; skipped if not provided) */
    notifier?: Notifier;
}
export declare class Executor {
    private taskManager;
    private logBase;
    private notifier;
    constructor(taskManager: TaskManager, options?: ExecutorOptions);
    /**
     * Execute `task.command` asynchronously.
     *
     * - Single-word / no-shell-metachar command → execve directly
     * - Otherwise → sh -c <command>
     * - stdout + stderr merged into gzip-compressed log file
     * - Timeout watchdog: SIGTERM, then SIGKILL after 5 s
     * - Calls TaskManager.complete() with final status + snippets
     */
    run(task: Task): Promise<void>;
    /**
     * Parse command string into [executable, args[]].
     *
     * - If command contains shell metacharacters → delegate to `sh -c`
     * - Otherwise → split on whitespace and execve directly (no shell)
     */
    private _parseCommand;
    /**
     * Return gzip log file path: <logBase>/<YYYY-MM-DD>/<taskId>.log.gz
     */
    private _logPath;
}
//# sourceMappingURL=index.d.ts.map