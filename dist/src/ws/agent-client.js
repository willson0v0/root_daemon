/**
 * WS AgentClient - src/ws/agent-client.ts
 *
 * WSL2 root-daemon WebSocket client for remote approval-web.
 * Connects to wss://approval.willson0v0.com/ws/agent, handles
 * task submission, approval results, and reconnection with
 * exponential backoff.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createLogger } from '../logger/index.js';
const log = createLogger('agent-client');
// ── Reconnect Config ──────────────────────────────────────────────────────────
const RECONNECT_CONFIG = {
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    multiplier: 2,
    jitterFactor: 0.2,
    maxAttempts: Infinity,
};
function calcDelay(attempt) {
    const base = Math.min(RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.multiplier, attempt), RECONNECT_CONFIG.maxDelayMs);
    const jitter = base * RECONNECT_CONFIG.jitterFactor * (Math.random() * 2 - 1);
    return Math.round(base + jitter);
}
// ── AgentClient ───────────────────────────────────────────────────────────────
export class AgentClient {
    config;
    executor;
    ws = null;
    connected = false;
    destroyed = false;
    reconnectAttempt = 0;
    reconnectTimer = null;
    /**
     * pendingTasks: requestId → PendingTask
     * Includes tasks queued while disconnected AND tasks waiting for TASK_ACK.
     */
    pendingTasks = new Map();
    /**
     * taskIdToPayload: taskId (number) → AgentTaskPayload
     * Built when TASK_ACK is received, used to construct synthetic Task for execution.
     */
    taskIdToPayload = new Map();
    /**
     * executedTaskIds: Set of taskIds already started execution.
     * Guards against duplicate APPROVAL_RESULT on reconnect.
     * Note: P2 server sends taskId as string in SYNC_PENDING; we Number()-convert on intake.
     */
    executedTaskIds = new Set();
    constructor(config, executor) {
        this.config = config;
        this.executor = executor;
    }
    connect() {
        if (this.destroyed)
            return;
        this._openSocket();
    }
    /**
     * Submit a task to the remote approval-web.
     * - If connected: send SUBMIT_TASK, await TASK_ACK, resolve with taskId.
     * - If disconnected: queue until reconnect, then auto-send.
     */
    submitTask(task) {
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const pending = { requestId, task, resolve, reject };
            this.pendingTasks.set(requestId, pending);
            if (this.connected && this.ws) {
                this._sendSubmitTask(requestId, task);
            }
            else {
                log.info({ requestId }, 'AgentClient not connected, task queued for reconnect');
            }
        });
    }
    destroy() {
        this.destroyed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
    }
    // ── Private: Socket Management ──────────────────────────────────────────────
    _openSocket() {
        if (this.destroyed)
            return;
        log.info({ url: this.config.url, attempt: this.reconnectAttempt }, 'Connecting to approval-web');
        const ws = new WebSocket(this.config.url, {
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
            },
        });
        this.ws = ws;
        ws.on('open', () => {
            log.info('WS connection opened');
            // Reset reconnect counter on successful open
            this.reconnectAttempt = 0;
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this._handleMessage(msg);
            }
            catch (err) {
                log.warn({ err }, 'Failed to parse WS message');
            }
        });
        ws.on('error', (err) => {
            log.warn({ err: err.message }, 'WS error');
        });
        ws.on('close', (code, reason) => {
            log.info({ code, reason: reason.toString() }, 'WS connection closed');
            this.connected = false;
            this.ws = null;
            this._scheduleReconnect();
        });
    }
    _scheduleReconnect() {
        if (this.destroyed)
            return;
        const delay = calcDelay(this.reconnectAttempt);
        this.reconnectAttempt++;
        log.info({ delay, attempt: this.reconnectAttempt }, 'Scheduling reconnect');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._openSocket();
        }, delay);
    }
    // ── Private: Message Handling ───────────────────────────────────────────────
    _handleMessage(msg) {
        switch (msg.type) {
            case 'CONNECTED':
                this._onConnected(msg);
                break;
            case 'TASK_ACK':
                this._onTaskAck(msg);
                break;
            case 'APPROVAL_RESULT':
                void this._onApprovalResult(msg);
                break;
            case 'PING':
                this._onPing(msg);
                break;
            case 'ERROR':
                log.error({ code: msg.code, message: msg.message }, 'Received ERROR from server');
                break;
            default:
                log.debug({ type: msg.type }, 'Unknown message type, ignoring');
        }
    }
    _onConnected(msg) {
        log.info({ machineLabel: msg.machineLabel }, 'CONNECTED received');
        this.connected = true;
        // Re-send all pending tasks (those queued while disconnected AND those awaiting ACK)
        for (const [requestId, pending] of this.pendingTasks) {
            log.debug({ requestId }, 'Re-sending pending task after reconnect');
            this._sendSubmitTask(requestId, pending.task);
        }
        // Request server to push any approved-but-unexecuted results
        this._send({
            type: 'SYNC_PENDING',
            machineLabel: this.config.machineLabel,
        });
    }
    _onTaskAck(msg) {
        const pending = this.pendingTasks.get(msg.requestId);
        if (!pending) {
            log.warn({ requestId: msg.requestId, taskId: msg.taskId }, 'TASK_ACK for unknown requestId');
            return;
        }
        // Record mapping for later execution on APPROVAL_RESULT
        this.taskIdToPayload.set(msg.taskId, pending.task);
        // Remove from pending (ACK received, no need to re-send)
        this.pendingTasks.delete(msg.requestId);
        log.info({ requestId: msg.requestId, taskId: msg.taskId }, 'TASK_ACK received, task registered');
        pending.resolve(msg.taskId);
    }
    async _onApprovalResult(msg) {
        // Normalize taskId to number (server may send string in some paths)
        const taskId = Number(msg.taskId);
        // Idempotency check: don't execute twice
        if (this.executedTaskIds.has(taskId)) {
            log.info({ taskId }, 'APPROVAL_RESULT already processed, sending RESULT_ACK and ignoring');
            this._send({ type: 'RESULT_ACK', taskId });
            return;
        }
        if (msg.action === 'approve') {
            // Mark before executing to prevent re-entry
            this.executedTaskIds.add(taskId);
            // ACK first: "client has started execution"
            this._send({ type: 'RESULT_ACK', taskId });
            let payload = this.taskIdToPayload.get(taskId);
            // Fallback: passive (N1) task — command/description come in APPROVAL_RESULT body
            if (!payload && msg.command) {
                log.info({ taskId, command: msg.command }, 'Fallback: building payload from APPROVAL_RESULT body');
                payload = {
                    command: msg.command,
                    description: msg.description ?? '',
                };
            }
            if (!payload) {
                log.error({ taskId }, 'No task payload found for taskId, cannot execute');
                return;
            }
            log.info({ taskId, command: payload.command }, 'Executing approved task');
            // Build a synthetic Task object for the Executor
            const task = {
                taskId: `ws-${taskId}`,
                command: payload.command,
                description: payload.description ?? '',
                riskHint: null,
                agentSessionId: `ws-agent-${this.config.machineLabel}`,
                submittedAt: Date.now(),
                expiresAt: Date.now() + 86400 * 1000,
                timeoutSec: 86400,
                status: 'APPROVED',
                approvedAt: Date.now(),
                completedAt: null,
                exitCode: null,
                stdoutSnippet: null,
                stderrSnippet: null,
                logFile: null,
                createdAt: Date.now(),
            };
            try {
                await this.executor.run(task);
                log.info({ taskId }, 'Task execution complete');
            }
            catch (err) {
                log.error({ taskId, err }, 'Task execution failed');
            }
        }
        else {
            // reject
            log.info({ taskId }, 'Task rejected, no execution');
            this._send({ type: 'RESULT_ACK', taskId });
        }
    }
    _onPing(msg) {
        this._send({ type: 'PONG', timestamp: msg.timestamp });
    }
    // ── Private: Send Helpers ───────────────────────────────────────────────────
    _send(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.warn({ type: obj['type'] }, 'Cannot send: WS not open');
            return;
        }
        try {
            this.ws.send(JSON.stringify(obj));
        }
        catch (err) {
            log.warn({ err }, 'Failed to send WS message');
        }
    }
    _sendSubmitTask(requestId, task) {
        this._send({
            type: 'SUBMIT_TASK',
            requestId,
            task: {
                command: task.command,
                description: task.description,
                requestedBy: task.requestedBy ?? 'root-daemon',
                metadata: task.metadata ?? {},
            },
        });
    }
}
//# sourceMappingURL=agent-client.js.map