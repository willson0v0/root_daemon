/**
 * Shared type definitions for root-daemon
 */

// Task status enum
export type TaskStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'DONE'
  | 'FAILED'
  | 'TIMEOUT';

// Task record (mirrors SQLite tasks table)
export interface Task {
  taskId: string;           // UUID v4
  command: string;
  description: string;
  riskHint?: string | null;
  agentSessionId: string;
  submittedAt: number;      // Unix ms
  expiresAt: number;        // Unix ms
  timeoutSec: number;
  status: TaskStatus;
  approvedAt?: number | null;
  completedAt?: number | null;
  exitCode?: number | null;
  stdoutSnippet?: string | null;
  stderrSnippet?: string | null;
  logFile?: string | null;
  createdAt: number;        // Unix ms
}

// IPC message types
export type IpcMessageType =
  | 'SUBMIT_TASK'
  | 'TASK_ACCEPTED'
  | 'TASK_RESULT'
  | 'QUERY_TASK'
  | 'TASK_STATUS'
  | 'ERROR';

export interface SubmitTaskPayload {
  command: string;
  description: string;
  riskHint?: string;
  agentSessionId: string;
  timeoutSec?: number;
  expiresInSec?: number;
}

export interface TaskAcceptedPayload {
  taskId: string;
  approvalLink: string;
  expiresAt: number;  // Unix ms
}

export interface TaskResultPayload {
  taskId: string;
  status: TaskStatus;
  exitCode: number | null;
  stdoutSnippet: string;
  stderrSnippet: string;
  logFile: string | null;
  completedAt: number;  // Unix ms
}

export interface QueryTaskPayload {
  taskId: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface IpcMessage<T = unknown> {
  $schema: string;
  type: IpcMessageType;
  payload: T;
}

// Consumed token record
export interface ConsumedToken {
  token: string;
  taskId: string;
  consumedAt: number;  // Unix ms
}

// Daemon configuration
export interface DaemonConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  nova: {
    webhookUrl: string;
    sessionKey: string;
  };
  db?: {
    path?: string;
  };
  web?: {
    port?: number;
    host?: string;
  };
  ipc?: {
    socketPath?: string;
  };
  hmacKey: Buffer;
}

// Raw config file (before hmacKey is added)
export interface RawConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  nova: {
    webhookUrl: string;
    sessionKey: string;
  };
  db?: {
    path?: string;
  };
  web?: {
    port?: number;
    host?: string;
  };
  ipc?: {
    socketPath?: string;
  };
}
