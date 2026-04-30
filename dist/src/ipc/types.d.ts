/**
 * IPC message type definitions for root-daemon
 * Implements §3.2.3 message JSON schema
 */
import type { TaskStatus, IpcMessageType } from '../types/index.js';
export type { IpcMessageType };
export type { TaskStatus };
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
    expiresAt: number;
}
export interface TaskResultPayload {
    taskId: string;
    status: TaskStatus;
    exitCode: number | null;
    stdoutSnippet: string;
    stderrSnippet: string;
    logFile: string | null;
    completedAt: number;
}
export interface QueryTaskPayload {
    taskId: string;
}
export interface TaskStatusPayload {
    taskId: string;
    status: TaskStatus;
    approvalLink: string | null;
    expiresAt: number | null;
    exitCode: number | null;
    completedAt: number | null;
}
export interface ErrorPayload {
    code: ErrorCode;
    message: string;
    taskId?: string | null;
}
export type ErrorCode = 'INVALID_MESSAGE' | 'TASK_NOT_FOUND' | 'INTERNAL_ERROR' | 'AUTH_FAILED';
export type IpcMessage = {
    $schema: 'ipc/v1/submit_task';
    type: 'SUBMIT_TASK';
    payload: SubmitTaskPayload;
} | {
    $schema: 'ipc/v1/task_accepted';
    type: 'TASK_ACCEPTED';
    payload: TaskAcceptedPayload;
} | {
    $schema: 'ipc/v1/task_result';
    type: 'TASK_RESULT';
    payload: TaskResultPayload;
} | {
    $schema: 'ipc/v1/query_task';
    type: 'QUERY_TASK';
    payload: QueryTaskPayload;
} | {
    $schema: 'ipc/v1/task_status';
    type: 'TASK_STATUS';
    payload: TaskStatusPayload;
} | {
    $schema: 'ipc/v1/error';
    type: 'ERROR';
    payload: ErrorPayload;
};
export declare const SCHEMA_MAP: Record<IpcMessageType, string>;
export declare function createMessage<T extends IpcMessageType>(type: T, payload: Extract<IpcMessage, {
    type: T;
}>['payload']): Extract<IpcMessage, {
    type: T;
}>;
export declare function createError(code: ErrorCode, message: string, taskId?: string | null): Extract<IpcMessage, {
    type: 'ERROR';
}>;
//# sourceMappingURL=types.d.ts.map