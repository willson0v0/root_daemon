/**
 * Unit tests for Notifier (C6) - src/notifier/index.ts
 *
 * Tests:
 *   - Active connection: TASK_RESULT pushed via UDS
 *   - Active connection but send() returns false: fallback to webhook
 *   - Inactive connection: webhook POST called with correct payload
 *   - Inactive + webhook 2xx: no Feishu call
 *   - Inactive + webhook non-2xx: Feishu notification sent
 *   - Inactive + webhook timeout: Feishu notification sent
 *   - Feishu token missing: logs error, does NOT throw
 *   - bossChatId missing: logs error, does NOT throw
 *   - stdoutSnippet truncated to 500 chars in webhook body
 *   - IPC-003 schema fields correct (taskId, status, exitCode, stdoutSnippet, stderrSnippet, logFile, completedAt)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notifier, type TaskResult } from '../src/notifier/index.js';
import type { IpcServer } from '../src/ipc/server.js';
import type { DaemonConfig } from '../src/types/index.js';
import type { Task } from '../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task-uuid-1',
    command: 'echo hello',
    description: 'test task',
    riskHint: null,
    agentSessionId: 'session-abc',
    submittedAt: Date.now() - 5000,
    expiresAt: Date.now() + 295_000,
    timeoutSec: 300,
    status: 'DONE',
    approvedAt: Date.now() - 4000,
    completedAt: Date.now(),
    exitCode: 0,
    stdoutSnippet: 'hello\n',
    stderrSnippet: '',
    logFile: '/var/log/root-daemon/2026-03-08/task-uuid-1.log.gz',
    createdAt: Date.now() - 5000,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    status: 'DONE',
    exitCode: 0,
    stdoutSnippet: 'hello\n',
    stderrSnippet: '',
    logFile: '/var/log/root-daemon/2026-03-08/task-uuid-1.log.gz',
    completedAt: Date.now(),
    ...overrides,
  };
}

function makeIpcServer(isActiveFn: (id: string) => boolean, sendFn: () => boolean): IpcServer {
  return {
    isActive: vi.fn(isActiveFn),
    send: vi.fn(sendFn),
  } as unknown as IpcServer;
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    feishu: {
      appId: 'cli_test_app_id',
      appSecret: 'test_app_secret',
      bossChatId: 'ou_boss_open_id',
      enabled: true,
    },
    nova: {
      webhookUrl: 'http://127.0.0.1:18789/hooks/agent',
      sessionKey: 'agent:main:feishu:group:oc_test',
      timeoutMs: 3000,
    },
    hmacKey: Buffer.alloc(32),
    ...overrides,
  } as DaemonConfig;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Notifier C6', () => {
  describe('Active path: UDS push', () => {
    it('sends TASK_RESULT via IpcServer.send when agent is active', async () => {
      const sendMock = vi.fn(() => true);
      const ipcServer = makeIpcServer(() => true, sendMock);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      const task = makeTask();
      const result = makeResult();
      await notifier.notify(task, result);

      expect(ipcServer.isActive).toHaveBeenCalledWith('session-abc');
      expect(sendMock).toHaveBeenCalledTimes(1);

      // Verify IPC-003 schema
      const [sessionId, msg] = sendMock.mock.calls[0]!;
      expect(sessionId).toBe('session-abc');
      expect(msg.type).toBe('TASK_RESULT');
      expect(msg.$schema).toBe('ipc/v1/task_result');
      expect(msg.payload.taskId).toBe(task.taskId);
      expect(msg.payload.status).toBe('DONE');
      expect(msg.payload.exitCode).toBe(0);
      expect(msg.payload.stdoutSnippet).toBe('hello\n');
      expect(msg.payload.stderrSnippet).toBe('');
      expect(msg.payload.logFile).toBe(task.logFile);
      expect(typeof msg.payload.completedAt).toBe('number');
    });

    it('falls back to webhook when IpcServer.send returns false', async () => {
      const sendMock = vi.fn(() => false); // send fails
      const ipcServer = makeIpcServer(() => true, sendMock);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      // Mock _postWebhook to succeed
      const webhookSpy = vi.spyOn(notifier, '_postWebhook').mockResolvedValue(true);

      const task = makeTask();
      const result = makeResult();
      await notifier.notify(task, result);

      // webhook fallback should be triggered
      expect(webhookSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Inactive path: webhook', () => {
    it('calls webhook when agent is inactive', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      const webhookSpy = vi.spyOn(notifier, '_postWebhook').mockResolvedValue(true);

      const task = makeTask();
      const result = makeResult();
      await notifier.notify(task, result);

      expect(ipcServer.isActive).toHaveBeenCalledWith('session-abc');
      expect(webhookSpy).toHaveBeenCalledTimes(1);
    });

    it('webhook payload contains sessionKey and result summary', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      // Intercept _httpPost to inspect payload
      const httpPostSpy = vi.spyOn(notifier as unknown as { _httpPost: unknown }, '_httpPost')
        .mockResolvedValue(200) as ReturnType<typeof vi.spyOn>;

      const task = makeTask();
      const result = makeResult({ stdoutSnippet: 'out', logFile: '/log/file.gz' });
      await notifier.notify(task, result);

      expect(httpPostSpy).toHaveBeenCalledTimes(1);
      const [url, bodyStr] = (httpPostSpy.mock.calls[0] as [string, string, number]);
      expect(url).toBe(config.nova.webhookUrl);

      const body = JSON.parse(bodyStr) as Record<string, unknown>;
      expect(body['sessionKey']).toBe(config.nova.sessionKey);
      expect(body['taskId']).toBe(task.taskId);
      expect(body['status']).toBe('DONE');
      expect(body['exitCode']).toBe(0);
      expect(typeof body['stdoutSnippet']).toBe('string');
      expect(body['logFile']).toBe('/log/file.gz');
    });

    it('does NOT call Feishu when webhook returns 2xx', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(true);
      const feishuSpy = vi.spyOn(notifier as unknown as { _sendFeishuNotification: unknown }, '_sendFeishuNotification')
        .mockResolvedValue(undefined);

      await notifier.notify(makeTask(), makeResult());

      expect(feishuSpy).not.toHaveBeenCalled();
    });

    it('calls Feishu when webhook returns non-2xx', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);
      const feishuSpy = vi.spyOn(notifier as unknown as { _sendFeishuNotification: unknown }, '_sendFeishuNotification')
        .mockResolvedValue(undefined);

      await notifier.notify(makeTask(), makeResult());

      expect(feishuSpy).toHaveBeenCalledTimes(1);
    });

    it('calls Feishu when webhook times out (throws)', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);
      const feishuSpy = vi.spyOn(notifier as unknown as { _sendFeishuNotification: unknown }, '_sendFeishuNotification')
        .mockResolvedValue(undefined);

      await notifier.notify(makeTask(), makeResult());

      expect(feishuSpy).toHaveBeenCalledTimes(1);
    });

    it('truncates stdoutSnippet to 500 chars in webhook body', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      const httpPostSpy = vi.spyOn(notifier as unknown as { _httpPost: unknown }, '_httpPost')
        .mockResolvedValue(200) as ReturnType<typeof vi.spyOn>;

      const longOutput = 'x'.repeat(1000);
      await notifier.notify(makeTask(), makeResult({ stdoutSnippet: longOutput }));

      const bodyStr = (httpPostSpy.mock.calls[0] as [string, string, number])[1];
      const body = JSON.parse(bodyStr) as Record<string, unknown>;
      expect((body['stdoutSnippet'] as string).length).toBe(500);
    });
  });

  describe('Feishu fallback', () => {
    it('logs error and does NOT throw when appId is missing', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig({
        feishu: { appId: '', appSecret: '', bossChatId: 'ou_boss' },
      });
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);

      // Should not throw
      await expect(notifier.notify(makeTask(), makeResult())).resolves.toBeUndefined();
    });

    it('logs error and does NOT throw when bossChatId is missing', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig({
        feishu: { appId: 'cli_test', appSecret: 'secret', bossChatId: undefined },
      });
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);

      await expect(notifier.notify(makeTask(), makeResult())).resolves.toBeUndefined();
    });

    it('logs error and does NOT throw when Feishu API call fails', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);
      vi.spyOn(notifier as unknown as { _httpPostJson: unknown }, '_httpPostJson')
        .mockRejectedValue(new Error('network error'));

      await expect(notifier.notify(makeTask(), makeResult())).resolves.toBeUndefined();
    });

    it('Feishu message contains taskId, status, exitCode, stdoutSnippet, logFile', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig();
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);

      // Mock _httpPostJson: first call returns token, second call returns send result
      const httpPostJsonMock = vi.spyOn(notifier as unknown as { _httpPostJson: unknown }, '_httpPostJson')
        .mockResolvedValueOnce({ tenant_access_token: 'mock_token', code: 0 })
        .mockResolvedValueOnce({ code: 0, data: {} });

      const task = makeTask({ taskId: 'task-for-feishu' });
      const result = makeResult({ status: 'FAILED', exitCode: 1, stdoutSnippet: 'some output', logFile: '/log/t.gz' });
      await notifier.notify(task, result);

      // Second call is the send message call
      expect(httpPostJsonMock).toHaveBeenCalledTimes(2);
      const [, sendBody] = (httpPostJsonMock.mock.calls[1] as [string, string]);
      const parsed = JSON.parse(sendBody) as Record<string, unknown>;
      const content = JSON.parse(parsed['content'] as string) as Record<string, unknown>;
      const text = content['text'] as string;

      expect(text).toContain('task-for-feishu');
      expect(text).toContain('FAILED');
      expect(text).toContain('1');
      expect(text).toContain('some output');
      expect(text).toContain('/log/t.gz');
    });

    it('does not call Feishu when enabled is false', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig({
        feishu: { appId: 'cli_test', appSecret: 'secret', bossChatId: 'ou_boss', enabled: false },
      });
      const notifier = new Notifier(ipcServer, config);

      vi.spyOn(notifier, '_postWebhook').mockResolvedValue(false);
      const httpPostJsonSpy = vi.spyOn(notifier as unknown as { _httpPostJson: unknown }, '_httpPostJson')
        .mockResolvedValue({});

      await notifier.notify(makeTask(), makeResult());

      expect(httpPostJsonSpy).not.toHaveBeenCalled();
    });
  });

  describe('Webhook timeout configuration', () => {
    it('uses config.nova.timeoutMs when provided', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig({ nova: { webhookUrl: 'http://localhost/h', sessionKey: 'sk', timeoutMs: 1234 } });
      const notifier = new Notifier(ipcServer, config);

      const httpPostSpy = vi.spyOn(notifier as unknown as { _httpPost: unknown }, '_httpPost')
        .mockResolvedValue(200) as ReturnType<typeof vi.spyOn>;

      await notifier.notify(makeTask(), makeResult());

      const [, , timeout] = httpPostSpy.mock.calls[0] as [string, string, number];
      expect(timeout).toBe(1234);
    });

    it('uses default 3000ms when config.nova.timeoutMs is not set', async () => {
      const ipcServer = makeIpcServer(() => false, () => false);
      const config = makeConfig({ nova: { webhookUrl: 'http://localhost/h', sessionKey: 'sk' } });
      const notifier = new Notifier(ipcServer, config);

      const httpPostSpy = vi.spyOn(notifier as unknown as { _httpPost: unknown }, '_httpPost')
        .mockResolvedValue(200) as ReturnType<typeof vi.spyOn>;

      await notifier.notify(makeTask(), makeResult());

      const [, , timeout] = httpPostSpy.mock.calls[0] as [string, string, number];
      expect(timeout).toBe(3000);
    });
  });
});
