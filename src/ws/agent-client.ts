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
import type { Executor } from '../executor/index.js';
import type { Task } from '../types/index.js';

const log = createLogger('agent-client');

// ── Reconnect Config ──────────────────────────────────────────────────────────

const RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitterFactor: 0.2,
  maxAttempts: Infinity,
};

function calcDelay(attempt: number): number {
  const base = Math.min(
    RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.multiplier, attempt),
    RECONNECT_CONFIG.maxDelayMs
  );
  const jitter = base * RECONNECT_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

// ── WS Message Types ──────────────────────────────────────────────────────────

interface ConnectedMessage {
  type: 'CONNECTED';
  machineLabel: string;
  timestamp: number;
}

interface TaskAckMessage {
  type: 'TASK_ACK';
  requestId: string;
  taskId: number;
}

interface ApprovalResultMessage {
  type: 'APPROVAL_RESULT';
  taskId: number;
  action: 'approve' | 'reject';
  timestamp: number;
  /** For passive (N1) tasks: command and description come in the message body itself */
  command?: string;
  description?: string;
}

interface PingMessage {
  type: 'PING';
  timestamp: number;
}

interface ErrorMessage {
  type: 'ERROR';
  code: string;
  message: string;
}

// SYNC_PENDING from server: re-push approved tasks for machine
interface SyncPendingResultMessage {
  type: 'SYNC_PENDING_RESULT';
  tasks: Array<{ taskId: number; action: 'approve' | 'reject' }>;
}

type IncomingMessage =
  | ConnectedMessage
  | TaskAckMessage
  | ApprovalResultMessage
  | PingMessage
  | ErrorMessage
  | SyncPendingResultMessage;

// ── Internal Types ────────────────────────────────────────────────────────────

export interface AgentTaskPayload {
  command: string;
  description: string;
  requestedBy?: string;
  metadata?: Record<string, unknown>;
}

interface PendingTask {
  requestId: string;
  task: AgentTaskPayload;
  resolve: (taskId: number) => void;
  reject: (err: Error) => void;
}

// ── ApprovalWebConfig ─────────────────────────────────────────────────────────

export interface ApprovalWebConfig {
  url: string;          // wss://approval.willson0v0.com/ws/agent
  apiKey: string;
  machineLabel: string; // "willson-pc"
}

// ── AgentClient ───────────────────────────────────────────────────────────────

export class AgentClient {
  private config: ApprovalWebConfig;
  private executor: Executor;

  private ws: WebSocket | null = null;
  private connected = false;
  private destroyed = false;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * pendingTasks: requestId → PendingTask
   * Includes tasks queued while disconnected AND tasks waiting for TASK_ACK.
   */
  private pendingTasks: Map<string, PendingTask> = new Map();

  /**
   * taskIdToPayload: taskId (number) → AgentTaskPayload
   * Built when TASK_ACK is received, used to construct synthetic Task for execution.
   */
  private taskIdToPayload: Map<number, AgentTaskPayload> = new Map();

  /**
   * executedTaskIds: Set of taskIds already started execution.
   * Guards against duplicate APPROVAL_RESULT on reconnect.
   * Note: P2 server sends taskId as string in SYNC_PENDING; we Number()-convert on intake.
   */
  private executedTaskIds: Set<number> = new Set();

  constructor(config: ApprovalWebConfig, executor: Executor) {
    this.config = config;
    this.executor = executor;
  }

  connect(): void {
    if (this.destroyed) return;
    this._openSocket();
  }

  /**
   * Submit a task to the remote approval-web.
   * - If connected: send SUBMIT_TASK, await TASK_ACK, resolve with taskId.
   * - If disconnected: queue until reconnect, then auto-send.
   */
  submitTask(task: AgentTaskPayload): Promise<number> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const pending: PendingTask = { requestId, task, resolve, reject };
      this.pendingTasks.set(requestId, pending);

      if (this.connected && this.ws) {
        this._sendSubmitTask(requestId, task);
      } else {
        log.info({ requestId }, 'AgentClient not connected, task queued for reconnect');
      }
    });
  }

  destroy(): void {
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

  private _openSocket(): void {
    if (this.destroyed) return;

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
        const msg = JSON.parse(data.toString()) as IncomingMessage;
        this._handleMessage(msg);
      } catch (err) {
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

  private _scheduleReconnect(): void {
    if (this.destroyed) return;

    const delay = calcDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    log.info({ delay, attempt: this.reconnectAttempt }, 'Scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  // ── Private: Message Handling ───────────────────────────────────────────────

  private _handleMessage(msg: IncomingMessage): void {
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
        log.debug({ type: (msg as { type: string }).type }, 'Unknown message type, ignoring');
    }
  }

  private _onConnected(msg: ConnectedMessage): void {
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

  private _onTaskAck(msg: TaskAckMessage): void {
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

  private async _onApprovalResult(msg: ApprovalResultMessage): Promise<void> {
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
      const task: Task = {
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
      } catch (err) {
        log.error({ taskId, err }, 'Task execution failed');
      }
    } else {
      // reject
      log.info({ taskId }, 'Task rejected, no execution');
      this._send({ type: 'RESULT_ACK', taskId });
    }
  }

  private _onPing(msg: PingMessage): void {
    this._send({ type: 'PONG', timestamp: msg.timestamp });
  }

  // ── Private: Send Helpers ───────────────────────────────────────────────────

  private _send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ type: obj['type'] }, 'Cannot send: WS not open');
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      log.warn({ err }, 'Failed to send WS message');
    }
  }

  private _sendSubmitTask(requestId: string, task: AgentTaskPayload): void {
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
