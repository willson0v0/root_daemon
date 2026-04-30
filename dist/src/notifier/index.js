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
import https from 'node:https';
import http from 'node:http';
import { createLogger } from '../logger/index.js';
import { createMessage } from '../ipc/types.js';
const log = createLogger('notifier');
// Snippet limit for webhook/feishu notification (500 chars per §3.6.2)
const NOTIFY_SNIPPET_LIMIT = 500;
// Default webhook timeout in ms (can be overridden in config)
const DEFAULT_WEBHOOK_TIMEOUT_MS = 3000;
/**
 * Notifier: handles post-execution result delivery.
 * Injected with IpcServer (for active-path push) and config (for webhook + Feishu).
 */
export class Notifier {
    ipcServer;
    config;
    webhookTimeoutMs;
    constructor(ipcServer, config, options = {}) {
        this.ipcServer = ipcServer;
        this.config = config;
        this.webhookTimeoutMs = options.webhookTimeoutMs ?? config.nova.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    }
    /**
     * Main entry point. Determine active vs inactive, route accordingly.
     *
     * @param task  - Completed task (status must be terminal)
     * @param result - Execution result details
     */
    async notify(task, result) {
        const { agentSessionId } = task;
        if (this.ipcServer.isActive(agentSessionId)) {
            // Active path: UDS push
            this._sendViaUds(task, result);
        }
        else {
            // Inactive path: webhook → fallback feishu
            await this._sendViaWebhookWithFallback(task, result);
        }
    }
    // ── Private: Active Path ──────────────────────────────────────────────────
    _sendViaUds(task, result) {
        const msg = createMessage('TASK_RESULT', {
            taskId: task.taskId,
            status: result.status,
            exitCode: result.exitCode,
            stdoutSnippet: result.stdoutSnippet ?? '',
            stderrSnippet: result.stderrSnippet ?? '',
            logFile: result.logFile,
            completedAt: result.completedAt,
        });
        const sent = this.ipcServer.send(task.agentSessionId, msg);
        if (sent) {
            log.info({ taskId: task.taskId }, 'TASK_RESULT pushed via UDS (active path)');
        }
        else {
            // Connection may have dropped between isActive() check and send()
            log.warn({ taskId: task.taskId }, 'UDS send failed (connection dropped); falling back to webhook');
            void this._sendViaWebhookWithFallback(task, result);
        }
    }
    // ── Private: Inactive Path ────────────────────────────────────────────────
    async _sendViaWebhookWithFallback(task, result) {
        const webhookSuccess = await this._postWebhook(task, result);
        if (!webhookSuccess) {
            await this._sendFeishuNotification(task, result);
        }
    }
    /**
     * POST result to Nova webhook.
     * Returns true on 2xx, false on timeout or non-2xx.
     */
    async _postWebhook(task, result) {
        const { webhookUrl, sessionKey, webhookToken } = this.config.nova;
        const stdoutSnippet = (result.stdoutSnippet ?? '').slice(0, NOTIFY_SNIPPET_LIMIT);
        const body = JSON.stringify({
            sessionKey,
            message: `【root-daemon】任务已完成，请继续工作流。\n\n你现在在正确的 session 里。行动步骤：\n1. 调用 sessions_history(limit=20) 恢复上下文（了解这个任务是什么、谁提交的、期望做什么）\n2. 用以下命令查询任务详情和输出：\n   node -e "const D=require('/home/willson0v0/root-daemon/node_modules/better-sqlite3'); const db=new D('/var/lib/root-daemon/root-daemon.db',{readonly:true}); console.log(db.prepare('SELECT command,status,exit_code,stdout_snippet,stderr_snippet FROM tasks WHERE task_id=?').get('${task.taskId}'));"\n3. 根据上下文判断并执行下一步。\n\n摘要：taskId=${task.taskId} status=${result.status} exitCode=${result.exitCode ?? 'null'}`,
            taskId: task.taskId,
            status: result.status,
            exitCode: result.exitCode,
            stdoutSnippet,
            logFile: result.logFile,
        });
        try {
            const statusCode = await this._httpPost(webhookUrl, body, this.webhookTimeoutMs, webhookToken);
            if (statusCode >= 200 && statusCode < 300) {
                log.info({ taskId: task.taskId, statusCode }, 'Webhook to Nova succeeded');
                return true;
            }
            log.warn({ taskId: task.taskId, statusCode }, 'Webhook returned non-2xx; falling back to Feishu');
            return false;
        }
        catch (err) {
            log.warn({ taskId: task.taskId, err }, 'Webhook POST failed; falling back to Feishu');
            return false;
        }
    }
    /**
     * Send fallback Feishu Bot message.
     * Does NOT throw; logs error if token is missing or request fails.
     */
    async _sendFeishuNotification(task, result) {
        const { appId, appSecret, bossChatId, enabled } = this.config.feishu;
        if (enabled === false) {
            log.warn({ taskId: task.taskId }, 'Feishu notifications disabled in config');
            return;
        }
        if (!appId || !appSecret) {
            log.error({ taskId: task.taskId }, 'Feishu Bot token (appId/appSecret) not configured; cannot send fallback notification');
            return;
        }
        if (!bossChatId) {
            log.error({ taskId: task.taskId }, 'feishu.bossChatId not configured; cannot send fallback notification');
            return;
        }
        try {
            // Step 1: Get tenant_access_token
            const tokenBody = JSON.stringify({ app_id: appId, app_secret: appSecret });
            const tokenJson = await this._httpPostJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', tokenBody, 5000);
            const tenantToken = tokenJson['tenant_access_token'];
            if (!tenantToken || typeof tenantToken !== 'string') {
                log.error({ taskId: task.taskId, tokenJson }, 'Failed to obtain Feishu tenant_access_token');
                return;
            }
            // Step 2: Send message
            const stdoutSnippet = (result.stdoutSnippet ?? '').slice(0, NOTIFY_SNIPPET_LIMIT);
            const msgText = `[root-daemon] Task result notification\n` +
                `taskId: ${task.taskId}\n` +
                `status: ${result.status}\n` +
                `exitCode: ${result.exitCode ?? 'N/A'}\n` +
                `stdoutSnippet: ${stdoutSnippet || '(empty)'}\n` +
                `logFile: ${result.logFile ?? 'N/A'}`;
            const msgBody = JSON.stringify({
                receive_id: bossChatId,
                msg_type: 'text',
                content: JSON.stringify({ text: msgText }),
            });
            const sendResult = await this._httpPostJson('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', msgBody, 5000, { Authorization: `Bearer ${tenantToken}` });
            log.info({ taskId: task.taskId, sendResult }, 'Feishu fallback notification sent');
        }
        catch (err) {
            log.error({ taskId: task.taskId, err }, 'Feishu fallback notification failed');
        }
    }
    // ── Private: HTTP Helpers ─────────────────────────────────────────────────
    /**
     * POST JSON body to URL. Returns HTTP status code.
     * Rejects on network error or timeout.
     */
    _httpPost(url, body, timeoutMs, bearerToken) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const lib = parsedUrl.protocol === 'https:' ? https : http;
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            };
            if (bearerToken) {
                headers['Authorization'] = `Bearer ${bearerToken}`;
            }
            const req = lib.request({
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers,
            }, (res) => {
                // Drain response body to free socket
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Webhook POST timed out after ${timeoutMs}ms`));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    /**
     * POST JSON body and parse response as JSON.
     * Rejects on network error, timeout, or non-2xx.
     */
    _httpPostJson(url, body, timeoutMs, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const lib = parsedUrl.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...extraHeaders,
                },
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        resolve(JSON.parse(text));
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`HTTP POST timed out after ${timeoutMs}ms`));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}
//# sourceMappingURL=index.js.map