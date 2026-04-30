/**
 * Shared type definitions for root-daemon
 */
export type TaskStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'DONE' | 'FAILED' | 'TIMEOUT';
export interface Task {
    taskId: string;
    command: string;
    description: string;
    riskHint?: string | null;
    agentSessionId: string;
    submittedAt: number;
    expiresAt: number;
    timeoutSec: number;
    status: TaskStatus;
    approvedAt?: number | null;
    completedAt?: number | null;
    exitCode?: number | null;
    stdoutSnippet?: string | null;
    stderrSnippet?: string | null;
    logFile?: string | null;
    createdAt: number;
}
export type IpcMessageType = 'SUBMIT_TASK' | 'TASK_ACCEPTED' | 'TASK_RESULT' | 'QUERY_TASK' | 'TASK_STATUS' | 'ERROR';
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
export interface ErrorPayload {
    code: string;
    message: string;
}
export interface IpcMessage<T = unknown> {
    $schema: string;
    type: IpcMessageType;
    payload: T;
}
export interface ConsumedToken {
    token: string;
    taskId: string;
    consumedAt: number;
}
export interface DaemonConfig {
    feishu: {
        appId: string;
        appSecret: string;
        /** Boss's open_id for fallback Feishu notification (C6) */
        bossChatId?: string;
        /** Set to false to disable Feishu notifications (default: true) */
        enabled?: boolean;
    };
    nova: {
        webhookUrl: string;
        sessionKey: string;
        webhookToken?: string;
        /** Webhook request timeout in ms (default: 3000) */
        timeoutMs?: number;
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
    approval?: {
        callbackPort?: number;
        callbackHost?: string;
    };
    approvalWeb?: {
        url: string;
        apiKey: string;
        machineLabel: string;
    };
}
export interface RawConfig {
    feishu: {
        appId: string;
        appSecret: string;
        bossChatId?: string;
        enabled?: boolean;
    };
    nova: {
        webhookUrl: string;
        sessionKey: string;
        webhookToken?: string;
        timeoutMs?: number;
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
    approval?: {
        callbackPort?: number;
        callbackHost?: string;
    };
    approvalWeb?: {
        url: string;
        apiKey: string;
        machineLabel: string;
    };
}
//# sourceMappingURL=index.d.ts.map