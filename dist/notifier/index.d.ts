/**
 * Notifier - C6 Component: Agent Result Notifier
 *
 * Responsibilities:
 *   - After command execution completes, determine Agent connection status
 *   - Active path: push TASK_RESULT via UDS (IpcServer.send)
 *   - Inactive path: POST webhook to wake up Nova
 *   - Fallback: send Feishu Bot message if webhook fails
 *
 * Implements §3.6 of DESIGN-root-daemon.md
 */
import type { Task } from '../types/index.js';
import type { IpcServer } from '../ipc/server.js';
import type { DaemonConfig } from '../types/index.js';
export interface TaskResult {
    status: 'DONE' | 'FAILED' | 'TIMEOUT' | 'REJECTED' | 'EXPIRED';
    exitCode: number | null;
    stdoutSnippet: string | null;
    stderrSnippet: string | null;
    logFile: string | null;
    completedAt: number;
}
export interface NotifierOptions {
    /** Override webhook timeout in ms (default: 3000) */
    webhookTimeoutMs?: number;
}
/**
 * Notifier: handles post-execution result delivery.
 * Injected with IpcServer (for active-path push) and config (for webhook + Feishu).
 */
export declare class Notifier {
    private ipcServer;
    private config;
    private webhookTimeoutMs;
    constructor(ipcServer: IpcServer, config: DaemonConfig, options?: NotifierOptions);
    /**
     * Main entry point. Determine active vs inactive, route accordingly.
     *
     * @param task  - Completed task (status must be terminal)
     * @param result - Execution result details
     */
    notify(task: Task, result: TaskResult): Promise<void>;
    private _sendViaUds;
    private _sendViaWebhookWithFallback;
    /**
     * POST result to Nova webhook.
     * Returns true on 2xx, false on timeout or non-2xx.
     */
    _postWebhook(task: Task, result: TaskResult): Promise<boolean>;
    /**
     * Send fallback Feishu Bot message.
     * Does NOT throw; logs error if token is missing or request fails.
     */
    _sendFeishuNotification(task: Task, result: TaskResult): Promise<void>;
    /**
     * POST JSON body to URL. Returns HTTP status code.
     * Rejects on network error or timeout.
     */
    _httpPost(url: string, body: string, timeoutMs: number): Promise<number>;
    /**
     * POST JSON body and parse response as JSON.
     * Rejects on network error, timeout, or non-2xx.
     */
    private _httpPostJson;
}
//# sourceMappingURL=index.d.ts.map