/**
 * Unit tests for ApprovalServer (C6)
 *
 * Covers:
 *   APPR-01: GET /health returns 200 {"status":"ok"}
 *   APPR-02: GET /approve normal flow → 200 HTML
 *   APPR-03: GET /approve missing params → 400
 *   APPR-04: GET /approve TokenExpiredError → 410
 *   APPR-05: GET /approve TokenInvalidError → 403
 *   APPR-06: GET /approve TokenAlreadyConsumedError → 409
 *   APPR-07: GET /approve task not found → 404
 *   APPR-08: GET /approve task state error → 409
 *   APPR-09: GET /approve unexpected error → 500
 *   APPR-10: GET /reject normal flow → 200 HTML
 *   APPR-11: TLS: uses https.createServer when cert+key present
 *   APPR-12: Unknown path → 404
 *   APPR-13: Non-GET method → 405
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { ApprovalServer } from '../src/approval/index.js';
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenAlreadyConsumedError,
} from '../src/token/index.js';
import type { DaemonConfig } from '../src/types/index.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}): DaemonConfig {
  return {
    feishu: { appId: 'aid', appSecret: 'asecret' },
    nova: { webhookUrl: 'http://localhost', sessionKey: 'sk' },
    web: { port: 0 },
    hmacKey: Buffer.alloc(32),
    ...overrides,
  } as DaemonConfig;
}

function makeMocks() {
  const tokenService = {
    verify: vi.fn(),
    consume: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn(),
  };
  const taskManager = {
    get: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  };
  return { tokenService, taskManager };
}

/** Fire a GET request to a running server and return {status, body} */
async function get(server: ApprovalServer & { _server?: http.Server }, path: string): Promise<{ status: number; body: string }> {
  // Access the private server reference via a workaround
  const srv = (server as unknown as { server: http.Server }).server;
  const addr = srv.address() as { port: number };
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('ApprovalServer', () => {
  let server: ApprovalServer;
  let tokenService: ReturnType<typeof makeMocks>['tokenService'];
  let taskManager: ReturnType<typeof makeMocks>['taskManager'];

  beforeEach(async () => {
    const mocks = makeMocks();
    tokenService = mocks.tokenService;
    taskManager = mocks.taskManager;
    server = new ApprovalServer(makeConfig(), taskManager as never, tokenService as never);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── health ────────────────────────────────────────────────────────────────

  it('APPR-01: GET /health returns 200 {status:ok}', async () => {
    const { status, body } = await get(server, '/health');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
  });

  // ── approve normal ────────────────────────────────────────────────────────

  it('APPR-02: GET /approve normal flow → 200', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'PENDING' });
    tokenService.verify.mockReturnValue(undefined);
    tokenService.consume.mockResolvedValue(undefined);
    taskManager.approve.mockReturnValue({ taskId: 't1', status: 'APPROVED' });

    const { status, body } = await get(server, '/approve?task_id=t1&token=tok&expires=9999999999');
    expect(status).toBe(200);
    expect(body).toContain('命令已批准');
  });

  // ── approve error branches ────────────────────────────────────────────────

  it('APPR-03: GET /approve missing params → 400', async () => {
    const { status } = await get(server, '/approve?task_id=t1');
    expect(status).toBe(400);
  });

  it('APPR-04: GET /approve TokenExpiredError → 410', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'PENDING' });
    tokenService.verify.mockImplementation(() => { throw new TokenExpiredError(); });

    const { status } = await get(server, '/approve?task_id=t1&token=tok&expires=1000');
    expect(status).toBe(410);
  });

  it('APPR-05: GET /approve TokenInvalidError → 403', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'PENDING' });
    tokenService.verify.mockImplementation(() => { throw new TokenInvalidError(); });

    const { status } = await get(server, '/approve?task_id=t1&token=bad&expires=9999999999');
    expect(status).toBe(403);
  });

  it('APPR-06: GET /approve TokenAlreadyConsumedError → 409', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'PENDING' });
    tokenService.verify.mockImplementation(() => { throw new TokenAlreadyConsumedError(); });

    const { status } = await get(server, '/approve?task_id=t1&token=tok&expires=9999999999');
    expect(status).toBe(409);
  });

  it('APPR-07: GET /approve task not found → 404', async () => {
    taskManager.get.mockReturnValue(null);

    const { status } = await get(server, '/approve?task_id=missing&token=tok&expires=9999999999');
    expect(status).toBe(404);
  });

  it('APPR-08: GET /approve task state error → 409', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'APPROVED' });
    tokenService.verify.mockReturnValue(undefined);
    tokenService.consume.mockResolvedValue(undefined);
    taskManager.approve.mockImplementation(() => {
      throw new Error('Cannot approve task t1: expected status in [PENDING], got APPROVED');
    });

    const { status } = await get(server, '/approve?task_id=t1&token=tok&expires=9999999999');
    expect(status).toBe(409);
  });

  it('APPR-09: GET /approve unexpected verify error → 500', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'PENDING' });
    tokenService.verify.mockImplementation(() => { throw new Error('DB exploded'); });

    const { status } = await get(server, '/approve?task_id=t1&token=tok&expires=9999999999');
    expect(status).toBe(500);
  });

  // ── reject ────────────────────────────────────────────────────────────────

  it('APPR-10: GET /reject normal flow → 200', async () => {
    taskManager.get.mockReturnValue({ taskId: 't1', command: 'ls', status: 'PENDING' });
    tokenService.verify.mockReturnValue(undefined);
    tokenService.consume.mockResolvedValue(undefined);
    taskManager.reject.mockReturnValue({ taskId: 't1', status: 'REJECTED' });

    const { status, body } = await get(server, '/reject?task_id=t1&token=tok&expires=9999999999');
    expect(status).toBe(200);
    expect(body).toContain('命令已拒绝');
  });

  // ── TLS ───────────────────────────────────────────────────────────────────

  it('APPR-11: uses https.createServer when tls config present', async () => {
    // Use real self-signed cert to test TLS path
    const https = await import('node:https');
    const tlsConfig = {
      ...makeConfig({ web: { port: 0 } }),
      tls: { certFile: '/tmp/test-cert.pem', keyFile: '/tmp/test-key.pem' },
    };
    const { tokenService: ts, taskManager: tm } = makeMocks();
    const tlsServer = new ApprovalServer(tlsConfig as DaemonConfig, tm as never, ts as never);
    await tlsServer.start();

    // Verify the inner server is an https.Server
    const inner = (tlsServer as unknown as { server: unknown }).server;
    expect(inner).toBeInstanceOf(https.Server);

    await tlsServer.stop();
  });

  // ── misc ──────────────────────────────────────────────────────────────────

  it('APPR-12: unknown path → 404', async () => {
    const { status } = await get(server, '/unknown');
    expect(status).toBe(404);
  });

  it('APPR-13: non-GET method → 405', async () => {
    const srv = (server as unknown as { server: http.Server }).server;
    const addr = srv.address() as { port: number };
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/health', method: 'POST' },
        (res) => { resolve({ status: res.statusCode ?? 0 }); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});
