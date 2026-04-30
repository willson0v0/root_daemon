/**
 * Approval HTTP Server - src/approval/index.ts
 *
 * Serves GET /approve, GET /reject, GET /health endpoints.
 * Supports optional TLS via config.tls.certFile / config.tls.keyFile.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';
import { createLogger } from '../logger/index.js';
import { TokenExpiredError, TokenInvalidError, TokenAlreadyConsumedError, } from '../token/index.js';
const log = createLogger('approval-server');
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
// ── ApprovalServer ────────────────────────────────────────────────────────────
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
        // Get task to obtain command
        const task = this.taskManager.get(taskId);
        if (!task) {
            sendError(res, 404, 'Task not found');
            return;
        }
        const command = task.command;
        // Verify token
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
        // Consume token
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
        // Approve task
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
//# sourceMappingURL=index.js.map