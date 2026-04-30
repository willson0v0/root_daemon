/**
 * Approval module - src/approval/index.ts
 *
 * Exports:
 * - ApprovalServer: browser-facing HTTP server (GET /approve, GET /reject, GET /health)
 * - InternalCallbackServer: internal callback receiver (POST /internal/callback)
 */
import type { DaemonConfig } from '../types/index.js';
import type { TaskManager } from '../task/index.js';
import type { TokenService } from '../token/index.js';
import type { Executor } from '../executor/index.js';
export declare class ApprovalServer {
    private config;
    private taskManager;
    private tokenService;
    private server;
    constructor(config: DaemonConfig, taskManager: TaskManager, tokenService: TokenService);
    start(): Promise<void>;
    stop(): Promise<void>;
    private _handle;
    private _handleApprove;
    private _handleReject;
}
export declare class InternalCallbackServer {
    private taskManager;
    private executor;
    private config;
    private server;
    constructor(taskManager: TaskManager, executor: Executor, config: DaemonConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private _handle;
    private _handleCallback;
}
//# sourceMappingURL=index.d.ts.map