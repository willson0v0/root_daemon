/**
 * WS AgentClient - src/ws/agent-client.ts
 *
 * WSL2 root-daemon WebSocket client for remote approval-web.
 * Connects to wss://approval.willson0v0.com/ws/agent, handles
 * task submission, approval results, and reconnection with
 * exponential backoff.
 */
import type { Executor } from '../executor/index.js';
export interface AgentTaskPayload {
    command: string;
    description: string;
    requestedBy?: string;
    metadata?: Record<string, unknown>;
}
export interface ApprovalWebConfig {
    url: string;
    apiKey: string;
    machineLabel: string;
}
export declare class AgentClient {
    private config;
    private executor;
    private ws;
    private connected;
    private destroyed;
    private reconnectAttempt;
    private reconnectTimer;
    /**
     * pendingTasks: requestId → PendingTask
     * Includes tasks queued while disconnected AND tasks waiting for TASK_ACK.
     */
    private pendingTasks;
    /**
     * taskIdToPayload: taskId (number) → AgentTaskPayload
     * Built when TASK_ACK is received, used to construct synthetic Task for execution.
     */
    private taskIdToPayload;
    /**
     * executedTaskIds: Set of taskIds already started execution.
     * Guards against duplicate APPROVAL_RESULT on reconnect.
     * Note: P2 server sends taskId as string in SYNC_PENDING; we Number()-convert on intake.
     */
    private executedTaskIds;
    constructor(config: ApprovalWebConfig, executor: Executor);
    connect(): void;
    /**
     * Submit a task to the remote approval-web.
     * - If connected: send SUBMIT_TASK, await TASK_ACK, resolve with taskId.
     * - If disconnected: queue until reconnect, then auto-send.
     */
    submitTask(task: AgentTaskPayload): Promise<number>;
    destroy(): void;
    private _openSocket;
    private _scheduleReconnect;
    private _handleMessage;
    private _onConnected;
    private _onTaskAck;
    private _onApprovalResult;
    private _onPing;
    private _send;
    private _sendSubmitTask;
}
//# sourceMappingURL=agent-client.d.ts.map