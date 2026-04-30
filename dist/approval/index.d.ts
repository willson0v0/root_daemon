/**
 * Approval HTTP Server - src/approval/index.ts
 *
 * Serves GET /approve, GET /reject, GET /health endpoints.
 * Supports optional TLS via config.tls.certFile / config.tls.keyFile.
 */
import type { DaemonConfig } from '../types/index.js';
import type { TaskManager } from '../task/index.js';
import type { TokenService } from '../token/index.js';
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
//# sourceMappingURL=index.d.ts.map