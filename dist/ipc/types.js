/**
 * IPC message type definitions for root-daemon
 * Implements §3.2.3 message JSON schema
 */
// Schema mapping
export const SCHEMA_MAP = {
    SUBMIT_TASK: 'ipc/v1/submit_task',
    TASK_ACCEPTED: 'ipc/v1/task_accepted',
    TASK_RESULT: 'ipc/v1/task_result',
    QUERY_TASK: 'ipc/v1/query_task',
    TASK_STATUS: 'ipc/v1/task_status',
    ERROR: 'ipc/v1/error',
};
// Helper to create typed messages
export function createMessage(type, payload) {
    return {
        $schema: SCHEMA_MAP[type],
        type,
        payload,
    };
}
export function createError(code, message, taskId) {
    return {
        $schema: 'ipc/v1/error',
        type: 'ERROR',
        payload: { code, message, taskId: taskId ?? null },
    };
}
//# sourceMappingURL=types.js.map