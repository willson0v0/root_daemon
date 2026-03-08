/**
 * IPC Layer Unit Tests - §8.2.2
 * Tests: IPC-01 through IPC-07
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { StreamParser } from '../src/ipc/parser.js';
import { encodeMessage, HEADER_SIZE, MAX_MESSAGE_SIZE } from '../src/ipc/framing.js';
import { IpcServer } from '../src/ipc/server.js';
import { IpcClient } from '../src/ipc/client.js';
import type { IpcMessage } from '../src/ipc/types.js';
import { createError } from '../src/ipc/types.js';

// Helper: build a raw frame buffer manually
function makeFrame(payloadStr: string): Buffer {
  const payload = Buffer.from(payloadStr, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function makeFrameObj(obj: unknown): Buffer {
  return makeFrame(JSON.stringify(obj));
}

const sampleMsg: IpcMessage = {
  $schema: 'ipc/v1/submit_task',
  type: 'SUBMIT_TASK',
  payload: {
    command: 'ls -la',
    description: 'List files',
    agentSessionId: 'sess-001',
  },
};

// ─── IPC-01: Single complete message frame ────────────────────────────────────
describe('IPC-01: single complete message frame', () => {
  it('parses a single framed message correctly', () => {
    const results: Array<{ ok: boolean; message?: IpcMessage }> = [];
    const parser = new StreamParser((r) => results.push(r));

    parser.push(makeFrameObj(sampleMsg));

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect(results[0]!.message).toEqual(sampleMsg);
    }
  });
});

// ─── IPC-02: Sticky packets (两条消息合并到一个 chunk) ──────────────────────
describe('IPC-02: sticky packets (两条消息合并到一个 chunk)', () => {
  it('correctly parses two messages in one chunk', () => {
    const results: Array<ReturnType<Parameters<typeof StreamParser.prototype.constructor>[0]> extends (...args: infer A) => unknown ? { ok: boolean; message?: IpcMessage; error?: { code: string; message: string } } : never> = [];
    const parser = new StreamParser((r) => results.push(r as never));

    const msg2: IpcMessage = {
      $schema: 'ipc/v1/query_task',
      type: 'QUERY_TASK',
      payload: { taskId: 'abc-123' },
    };

    const combined = Buffer.concat([makeFrameObj(sampleMsg), makeFrameObj(msg2)]);
    parser.push(combined);

    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    if (results[0]!.ok && results[1]!.ok) {
      expect((results[0] as { ok: true; message: IpcMessage }).message.type).toBe('SUBMIT_TASK');
      expect((results[1] as { ok: true; message: IpcMessage }).message.type).toBe('QUERY_TASK');
    }
  });
});

// ─── IPC-03: Half-packet (消息头跨两个 chunk) ──────────────────────────────
describe('IPC-03: half-packet (消息头跨两个 chunk)', () => {
  it('waits for second chunk to complete header parsing', () => {
    const results: Array<{ ok: boolean; message?: IpcMessage; error?: unknown }> = [];
    const parser = new StreamParser((r) => results.push(r));

    const frame = makeFrameObj(sampleMsg);
    // Split in the middle of the 4-byte header
    const chunk1 = frame.subarray(0, 2);
    const chunk2 = frame.subarray(2);

    parser.push(chunk1);
    expect(results).toHaveLength(0); // Not enough for header yet

    parser.push(chunk2);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  });
});

// ─── IPC-04: Body spans three chunks ────────────────────────────────────────
describe('IPC-04: message body spans three chunks', () => {
  it('reassembles body correctly across three chunks', () => {
    const results: Array<{ ok: boolean; message?: IpcMessage; error?: unknown }> = [];
    const parser = new StreamParser((r) => results.push(r));

    const frame = makeFrameObj(sampleMsg);
    const third = Math.floor(frame.length / 3);

    parser.push(frame.subarray(0, third));
    expect(results).toHaveLength(0);

    parser.push(frame.subarray(third, third * 2));
    expect(results).toHaveLength(0);

    parser.push(frame.subarray(third * 2));
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    if (results[0]!.ok) {
      expect((results[0] as { ok: true; message: IpcMessage }).message).toEqual(sampleMsg);
    }
  });
});

// ─── IPC-05: Message exceeds 1MB limit ──────────────────────────────────────
describe('IPC-05: message exceeds 1MB limit', () => {
  it('returns ERROR(INVALID_MESSAGE) for oversized messages', () => {
    const results: Array<{ ok: boolean; message?: IpcMessage; error?: { code: string } }> = [];
    const parser = new StreamParser((r) => results.push(r));

    // Create a header claiming MAX_MESSAGE_SIZE + 1 bytes
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 0);

    parser.push(header);

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect((results[0] as { ok: false; error: { code: string } }).error.code).toBe('INVALID_MESSAGE');
  });
});

// ─── IPC-06: Invalid JSON payload ────────────────────────────────────────────
describe('IPC-06: invalid JSON payload', () => {
  it('returns ERROR(INVALID_MESSAGE) for non-JSON body', () => {
    const results: Array<{ ok: boolean; message?: IpcMessage; error?: { code: string } }> = [];
    const parser = new StreamParser((r) => results.push(r));

    parser.push(makeFrame('not valid json {{{'));

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect((results[0] as { ok: false; error: { code: string } }).error.code).toBe('INVALID_MESSAGE');
  });
});

// ─── IPC-07: Zero-length message ─────────────────────────────────────────────
describe('IPC-07: zero-length message', () => {
  it('returns ERROR(INVALID_MESSAGE) for length=0', () => {
    const results: Array<{ ok: boolean; message?: IpcMessage; error?: { code: string } }> = [];
    const parser = new StreamParser((r) => results.push(r));

    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(0, 0);
    parser.push(header);

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect((results[0] as { ok: false; error: { code: string } }).error.code).toBe('INVALID_MESSAGE');
  });
});

// ─── Smoke test: UDS connect + send SUBMIT_TASK ──────────────────────────────
describe('Smoke: UDS connection and SUBMIT_TASK round-trip', () => {
  const socketPath = `/tmp/test-ipc-${Date.now()}.sock`;
  let server: IpcServer;
  let client: IpcClient;

  beforeEach(async () => {
    server = new IpcServer({ socketPath });

    // Echo back a TASK_ACCEPTED for any SUBMIT_TASK
    server.on('message', (msg: IpcMessage, conn) => {
      if (msg.type === 'SUBMIT_TASK') {
        conn.send({
          $schema: 'ipc/v1/task_accepted',
          type: 'TASK_ACCEPTED',
          payload: {
            taskId: 'test-task-id-001',
            approvalLink: 'https://example.com/approve/test-task-id-001',
            expiresAt: Date.now() + 600_000,
          },
        });
      }
    });

    await server.listen();

    client = new IpcClient({ socketPath });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await server.close();
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it('sends SUBMIT_TASK and receives TASK_ACCEPTED', async () => {
    const response = await client.request(sampleMsg, 3000);

    expect(response.type).toBe('TASK_ACCEPTED');
    if (response.type === 'TASK_ACCEPTED') {
      expect(response.payload.taskId).toBe('test-task-id-001');
      expect(response.payload.approvalLink).toContain('approve');
    }
  });

  it('encodeMessage + decodeMessage round-trip', () => {
    const encoded = encodeMessage(sampleMsg);
    expect(encoded.length).toBe(HEADER_SIZE + Buffer.byteLength(JSON.stringify(sampleMsg)));

    const length = encoded.readUInt32BE(0);
    expect(length).toBe(Buffer.byteLength(JSON.stringify(sampleMsg)));

    const parsed = JSON.parse(encoded.subarray(HEADER_SIZE).toString('utf8'));
    expect(parsed).toEqual(sampleMsg);
  });

  it('createError helper returns correct shape', () => {
    const err = createError('TASK_NOT_FOUND', 'Task xyz not found', 'xyz');
    expect(err.type).toBe('ERROR');
    expect(err.$schema).toBe('ipc/v1/error');
    expect(err.payload.code).toBe('TASK_NOT_FOUND');
    expect(err.payload.taskId).toBe('xyz');
  });
});

// ─── M-1/M-2/M-3: send() and isActive() by agentSessionId ──────────────────
describe('IpcServer.send() and isActive() by agentSessionId (M-1, M-2, M-3)', () => {
  const socketPath = `/tmp/test-ipc-session-${Date.now()}.sock`;
  let server: IpcServer;
  let client: IpcClient;

  beforeEach(async () => {
    server = new IpcServer({ socketPath });
    await server.listen();
    client = new IpcClient({ socketPath });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await server.close();
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it('isActive returns false before SUBMIT_TASK is received', () => {
    expect(server.isActive('sess-abc')).toBe(false);
  });

  it('isActive returns true after SUBMIT_TASK with matching agentSessionId', async () => {
    const msg: IpcMessage = {
      $schema: 'ipc/v1/submit_task',
      type: 'SUBMIT_TASK',
      payload: {
        command: 'echo hi',
        description: 'test',
        agentSessionId: 'sess-m3-test',
      },
    };

    // Send message and wait for server to process it
    await new Promise<void>((resolve) => {
      server.once('message', () => resolve());
      client.send(msg);
    });

    expect(server.isActive('sess-m3-test')).toBe(true);
    expect(server.isActive('sess-nonexistent')).toBe(false);
  });

  it('send() delivers a message to the correct session', async () => {
    const sessionId = 'sess-send-test';
    const msg: IpcMessage = {
      $schema: 'ipc/v1/submit_task',
      type: 'SUBMIT_TASK',
      payload: {
        command: 'echo hi',
        description: 'test',
        agentSessionId: sessionId,
      },
    };

    // Wait for server to register the session
    await new Promise<void>((resolve) => {
      server.once('message', () => resolve());
      client.send(msg);
    });

    // Now server sends a message back via session-addressed send()
    const received = new Promise<IpcMessage>((resolve) => {
      client.once('message', resolve);
    });

    const result = server.send(sessionId, {
      $schema: 'ipc/v1/task_accepted',
      type: 'TASK_ACCEPTED',
      payload: {
        taskId: 'pushed-task-001',
        approvalLink: 'https://example.com/approve/pushed-task-001',
        expiresAt: Date.now() + 60_000,
      },
    });

    expect(result).toBe(true);
    const response = await received;
    expect(response.type).toBe('TASK_ACCEPTED');
    if (response.type === 'TASK_ACCEPTED') {
      expect(response.payload.taskId).toBe('pushed-task-001');
    }
  });

  it('send() returns false for unknown sessionId', () => {
    const result = server.send('unknown-session', {
      $schema: 'ipc/v1/error',
      type: 'ERROR',
      payload: { code: 'INTERNAL_ERROR', message: 'test', taskId: null },
    });
    expect(result).toBe(false);
  });
});
