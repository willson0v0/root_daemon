/**
 * Approval module - src/approval/index.ts
 *
 * Exports:
 * - ApprovalServer: browser-facing HTTP server (GET /approve, GET /reject, GET /health)
 * - InternalCallbackServer: internal callback receiver (POST /internal/callback)
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';
import { createLogger } from '../logger/index.js';
import { TokenExpiredError, TokenInvalidError, TokenAlreadyConsumedError, } from '../token/index.js';
const log = createLogger('approval-server');
const callbackLog = createLogger('internal-callback-server');
// ── HTML helpers ──────────────────────────────────────────────────────────────
function htmlPage(title, body) {
    return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5;}
.card{background:#fff;border-radius:8px;padding:40px 60px;box-shadow:0 2px 12px rgba(0,0,0,0.1);text-align:center;}</style>
</head>
<body><div class="card"><h1>${body}</h1></div></body>
</html>`;
}
function sendHtml(res, status, title, body) {
    const html = htmlPage(title, body);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}
function sendJson(res, status, obj) {
    const json = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
}
function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
}
// ── ApprovalServer (browser-facing) ──────────────────────────────────────────
export class ApprovalServer {
    config;
    taskManager;
    tokenService;
    server = null;
    constructor(config, taskManager, tokenService) {
        this.config = config;
        this.taskManager = taskManager;
        this.tokenService = tokenService;
    }
    async start() {
        const port = this.config.web?.port ?? 3000;
        const host = this.config.web?.host ?? '0.0.0.0';
        // Determine TLS
        const tlsCfg = this.config.tls;
        const useTls = !!(tlsCfg?.certFile && tlsCfg?.keyFile);
        if (useTls) {
            const cert = fs.readFileSync(tlsCfg.certFile);
            const key = fs.readFileSync(tlsCfg.keyFile);
            this.server = https.createServer({ cert, key }, (req, res) => this._handle(req, res));
            log.info({ port, host }, 'Starting HTTPS approval server');
        }
        else {
            this.server = http.createServer((req, res) => this._handle(req, res));
            log.info({ port, host }, 'Starting HTTP approval server');
        }
        return new Promise((resolve, reject) => {
            this.server.listen(port, host, () => {
                log.info({ port, host }, 'Approval server listening');
                resolve();
            });
            this.server.once('error', reject);
        });
    }
    async stop() {
        if (!this.server)
            return;
        return new Promise((resolve, reject) => {
            this.server.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    _handle(req, res) {
        const base = `http://${req.headers.host ?? 'localhost'}`;
        const url = new URL(req.url ?? '/', base);
        const pathname = url.pathname;
        if (req.method !== 'GET') {
            sendError(res, 405, 'Method Not Allowed');
            return;
        }
        if (pathname === '/health') {
            sendJson(res, 200, { status: 'ok' });
        }
        else if (pathname === '/approve') {
            void this._handleApprove(url, res);
        }
        else if (pathname === '/reject') {
            void this._handleReject(url, res);
        }
        else {
            sendError(res, 404, 'Not Found');
        }
    }
    async _handleApprove(url, res) {
        const taskId = url.searchParams.get('task_id');
        const token = url.searchParams.get('token');
        const expiresStr = url.searchParams.get('expires');
        if (!taskId || !token || !expiresStr) {
            sendError(res, 400, 'Missing required parameters: task_id, token, expires');
            return;
        }
        const expires = parseInt(expiresStr, 10);
        if (isNaN(expires)) {
            sendError(res, 400, 'Invalid expires parameter');
            return;
        }
        const task = this.taskManager.get(taskId);
        if (!task) {
            sendError(res, 404, 'Task not found');
            return;
        }
        const command = task.command;
        try {
            this.tokenService.verify(taskId, command, token, expires);
        }
        catch (err) {
            if (err instanceof TokenExpiredError) {
                sendError(res, 410, 'Token has expired');
                return;
            }
            if (err instanceof TokenInvalidError) {
                sendError(res, 403, 'Token is invalid');
                return;
            }
            if (err instanceof TokenAlreadyConsumedError) {
                sendError(res, 409, 'Token already consumed');
                return;
            }
            log.error({ err }, 'Unexpected error during token verify');
            sendError(res, 500, 'Internal server error');
            return;
        }
        try {
            await this.tokenService.consume(token, taskId);
        }
        catch (err) {
            if (err instanceof TokenAlreadyConsumedError) {
                sendError(res, 409, 'Token already consumed');
                return;
            }
            log.error({ err }, 'Unexpected error during token consume');
            sendError(res, 500, 'Internal server error');
            return;
        }
        try {
            this.taskManager.approve(taskId);
        }
        catch (err) {
            const message = err.message ?? '';
            if (message.includes('not found')) {
                sendError(res, 404, 'Task not found');
                return;
            }
            if (message.includes('Cannot approve')) {
                sendError(res, 409, 'Task is in an invalid state for approval');
                return;
            }
            log.error({ err }, 'Unexpected error during taskManager.approve');
            sendError(res, 500, 'Internal server error');
            return;
        }
        log.info({ taskId }, '/approve succeeded');
        sendHtml(res, 200, '命令已批准', '✅ 命令已批准，即将执行');
    }
    async _handleReject(url, res) {
        const taskId = url.searchParams.get('task_id');
        const token = url.searchParams.get('token');
        const expiresStr = url.searchParams.get('expires');
        if (!taskId || !token || !expiresStr) {
            sendError(res, 400, 'Missing required parameters: task_id, token, expires');
            return;
        }
        const expires = parseInt(expiresStr, 10);
        if (isNaN(expires)) {
            sendError(res, 400, 'Invalid expires parameter');
            return;
        }
        let command;
        const task = this.taskManager.get(taskId);
        if (!task) {
            sendError(res, 404, 'Task not found');
            return;
        }
        command = task.command;
        try {
            this.tokenService.verify(taskId, command, token, expires);
        }
        catch (err) {
            if (err instanceof TokenExpiredError) {
                sendError(res, 410, 'Token has expired');
                return;
            }
            if (err instanceof TokenInvalidError) {
                sendError(res, 403, 'Token is invalid');
                return;
            }
            if (err instanceof TokenAlreadyConsumedError) {
                sendError(res, 409, 'Token already consumed');
                return;
            }
            log.error({ err }, 'Unexpected error during token verify');
            sendError(res, 500, 'Internal server error');
            return;
        }
        try {
            await this.tokenService.consume(token, taskId);
        }
        catch (err) {
            if (err instanceof TokenAlreadyConsumedError) {
                sendError(res, 409, 'Token already consumed');
                return;
            }
            log.error({ err }, 'Unexpected error during token consume');
            sendError(res, 500, 'Internal server error');
            return;
        }
        try {
            this.taskManager.reject(taskId);
        }
        catch (err) {
            const message = err.message ?? '';
            if (message.includes('not found')) {
                sendError(res, 404, 'Task not found');
                return;
            }
            if (message.includes('Cannot reject')) {
                sendError(res, 409, 'Task is in an invalid state for rejection');
                return;
            }
            log.error({ err }, 'Unexpected error during taskManager.reject');
            sendError(res, 500, 'Internal server error');
            return;
        }
        log.info({ taskId }, '/reject succeeded');
        sendHtml(res, 200, '命令已拒绝', '❌ 命令已拒绝');
    }
}
// ── InternalCallbackServer (internal, approval-web → root-daemon) ─────────────
export class InternalCallbackServer {
    taskManager;
    executor;
    config;
    server = null;
    constructor(taskManager, executor, config) {
        this.taskManager = taskManager;
        this.executor = executor;
        this.config = config;
    }
    async start() {
        const port = this.config.approval?.callbackPort ?? 3001;
        const host = this.config.approval?.callbackHost ?? '127.0.0.1';
        this.server = http.createServer((req, res) => this._handle(req, res));
        return new Promise((resolve, reject) => {
            this.server.listen(port, host, () => {
                callbackLog.info({ port, host }, 'InternalCallbackServer listening');
                resolve();
            });
            this.server.once('error', reject);
        });
    }
    async stop() {
        if (!this.server)
            return;
        return new Promise((resolve, reject) => {
            this.server.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    _handle(req, res) {
        // Only accept requests from 127.0.0.1
        const remoteAddress = req.socket.remoteAddress;
        const isLocal = remoteAddress === '127.0.0.1' ||
            remoteAddress === '::1' ||
            remoteAddress === '::ffff:127.0.0.1';
        if (!isLocal) {
            callbackLog.warn({ remoteAddress }, 'Rejected non-local request');
            sendJson(res, 403, { error: 'Forbidden' });
            return;
        }
        if (req.method === 'POST' && req.url === '/internal/callback') {
            void this._handleCallback(req, res);
        }
        else {
            sendJson(res, 404, { error: 'Not Found' });
        }
    }
    async _handleCallback(req, res) {
        let body = '';
        try {
            await new Promise((resolve, reject) => {
                req.on('data', (chunk) => { body += chunk.toString(); });
                req.on('end', resolve);
                req.on('error', reject);
            });
        }
        catch (err) {
            callbackLog.error({ err }, 'Error reading request body');
            sendJson(res, 500, { error: 'Internal server error' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            sendJson(res, 400, { error: 'Invalid JSON' });
            return;
        }
        const { taskId, action } = parsed;
        if (typeof taskId !== 'string' || !taskId) {
            sendJson(res, 400, { error: 'Missing or invalid taskId' });
            return;
        }
        if (action !== 'approve' && action !== 'reject') {
            sendJson(res, 400, { error: 'Invalid action, must be "approve" or "reject"' });
            return;
        }
        const task = this.taskManager.get(taskId);
        if (!task) {
            sendJson(res, 404, { error: 'Task not found' });
            return;
        }
        try {
            if (action === 'approve') {
                this.taskManager.approve(taskId);
                callbackLog.info({ taskId }, 'Task approved via internal callback, executing');
                const updatedTask = this.taskManager.get(taskId);
                if (updatedTask) {
                    void this.executor.run(updatedTask);
                }
            }
            else {
                this.taskManager.reject(taskId);
                callbackLog.info({ taskId }, 'Task rejected via internal callback');
            }
            sendJson(res, 200, { ok: true });
        }
        catch (err) {
            const message = err.message ?? '';
            if (message.includes('not found')) {
                sendJson(res, 404, { error: 'Task not found' });
                return;
            }
            callbackLog.error({ err, taskId, action }, 'Error processing callback');
            sendJson(res, 500, { error: 'Internal server error' });
        }
    }
}
//# sourceMappingURL=index.js.map