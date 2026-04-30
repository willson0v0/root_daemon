/**
 * Unit tests for Executor (C5) - src/executor/index.ts
 *
 * Tests:
 *   - Single command execve (no shell)
 *   - Multi-word / shell-metachar → sh -c
 *   - stdout/stderr snippets captured correctly (4KB cap)
 *   - Log file created and gzip-compressed
 *   - TaskManager.complete() called with correct status + snippets
 *   - Timeout: SIGTERM → SIGKILL, status TIMEOUT
 *   - Exit code != 0 → status FAILED
 *   - Exit code 0 → status DONE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { Executor } from '../src/executor/index.js';
import type { Task } from '../src/types/index.js';
import type { TaskManager } from '../src/task/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
  return dir;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'test-task-id',
    command: 'echo hello',
    description: 'test',
    riskHint: null,
    agentSessionId: 'session-1',
    submittedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    timeoutSec: 5,
    status: 'APPROVED',
    approvedAt: Date.now(),
    completedAt: null,
    exitCode: null,
    stdoutSnippet: null,
    stderrSnippet: null,
    logFile: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTaskManager(): TaskManager {
  return {
    complete: vi.fn(),
    submit: vi.fn(),
    get: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    list: vi.fn(),
    startExpiryScanner: vi.fn(),
    stopExpiryScanner: vi.fn(),
    restore: vi.fn(),
  } as unknown as TaskManager;
}

/** Read a .gz file and return its uncompressed content as a string */
async function readGzip(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    const source = fs.createReadStream(filePath);
    source.pipe(gunzip);
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    gunzip.on('error', reject);
    source.on('error', reject);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Executor (C5)', () => {
  let logBase: string;
  let taskManager: TaskManager;
  let executor: Executor;

  beforeEach(() => {
    logBase = makeTmpDir();
    taskManager = makeTaskManager();
    executor = new Executor(taskManager, { logBase });
  });

  afterEach(() => {
    // Clean up tmp log dir
    fs.rmSync(logBase, { recursive: true, force: true });
  });

  // ── Basic execution ────────────────────────────────────────────────────────

  it('runs a simple echo command and reports DONE', async () => {
    const task = makeTask({ command: 'echo hello' });
    await executor.run(task);

    expect(taskManager.complete).toHaveBeenCalledOnce();
    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[0]).toBe(task.taskId);
    expect(call[1].status).toBe('DONE');
    expect(call[1].exitCode).toBe(0);
  });

  it('captures stdout snippet', async () => {
    const task = makeTask({ command: 'echo hello-world' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].stdoutSnippet).toContain('hello-world');
  });

  it('captures stderr snippet', async () => {
    const task = makeTask({ command: 'sh -c "echo err >&2"' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].stderrSnippet).toContain('err');
  });

  it('creates a gzip log file with combined output', async () => {
    const task = makeTask({ command: 'echo log-output' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    const logFile = call[1].logFile!;
    expect(logFile).toBeTruthy();
    expect(fs.existsSync(logFile)).toBe(true);

    const content = await readGzip(logFile);
    expect(content).toContain('log-output');
  });

  it('log file is in <logBase>/<YYYY-MM-DD>/<taskId>.log.gz', async () => {
    const task = makeTask({ command: 'echo x', taskId: 'my-task-uuid' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    const logFile = call[1].logFile!;
    const dateStr = new Date().toISOString().slice(0, 10);
    expect(logFile).toContain(dateStr);
    expect(logFile).toContain('my-task-uuid.log.gz');
  });

  // ── Exit code handling ────────────────────────────────────────────────────

  it('reports FAILED for non-zero exit code', async () => {
    const task = makeTask({ command: 'false' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].status).toBe('FAILED');
    expect(call[1].exitCode).toBe(1);
  });

  it('reports DONE for exit code 0', async () => {
    const task = makeTask({ command: 'true' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].status).toBe('DONE');
    expect(call[1].exitCode).toBe(0);
  });

  // ── Shell metachar detection ───────────────────────────────────────────────

  it('uses sh -c for commands with pipe (|)', async () => {
    const task = makeTask({ command: 'echo foo | cat' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].status).toBe('DONE');
    expect(call[1].stdoutSnippet).toContain('foo');
  });

  it('uses sh -c for commands with redirection (>)', async () => {
    const outFile = path.join(logBase, 'redirect-test.txt');
    const task = makeTask({ command: `echo redirected > ${outFile}` });
    await executor.run(task);

    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, 'utf8').trim()).toBe('redirected');
  });

  it('uses sh -c for multi-command sequences (;)', async () => {
    const task = makeTask({ command: 'echo first; echo second' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].status).toBe('DONE');
    expect(call[1].stdoutSnippet).toContain('first');
  });

  it('execve directly for simple command without shell metachar', async () => {
    // If executed directly (no shell), args are passed as separate tokens
    const task = makeTask({ command: 'printf hello' });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].stdoutSnippet).toBe('hello');
  });

  // ── Snippet size cap (4KB) ─────────────────────────────────────────────────

  it('caps stdout snippet at 4096 bytes', async () => {
    // Generate >4KB of stdout
    const task = makeTask({
      command: 'sh -c "dd if=/dev/urandom bs=8192 count=1 2>/dev/null | base64"',
      timeoutSec: 10,
    });
    await executor.run(task);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].stdoutSnippet!.length).toBeLessThanOrEqual(4096);
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  it('reports TIMEOUT and kills process after timeoutSec', async () => {
    // Use a short timeout (1s) against a long-running sleep
    const task = makeTask({ command: 'sleep 60', timeoutSec: 1 });
    const start = Date.now();
    await executor.run(task);
    const elapsed = Date.now() - start;

    // Should have finished well under 60s (within ~7s: 1s timeout + 5s SIGKILL)
    expect(elapsed).toBeLessThan(10_000);

    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[1].status).toBe('TIMEOUT');
  }, 15_000); // extended test timeout

  // ── TaskManager.complete() not throwing ───────────────────────────────────

  it('does not throw if TaskManager.complete() throws (task removed)', async () => {
    vi.mocked(taskManager.complete).mockImplementation(() => {
      throw new Error('task not found');
    });

    const task = makeTask({ command: 'echo ok' });
    await expect(executor.run(task)).resolves.toBeUndefined();
  });

  // ── fileStream error path ─────────────────────────────────────────────────

  it('calls taskManager.complete() with logFile=null when fileStream emits error', async () => {
    // Use a logBase path that is actually a file, so createWriteStream will succeed initially
    // but we can intercept the stream via mock. Instead, we use a read-only dir trick:
    // Create a file where the log directory should be, so mkdir fails... but that would
    // reject the promise. Instead, mock fs.createWriteStream to return a stream that errors.

    const task = makeTask({ command: 'echo hello', taskId: 'stream-error-task' });

    // Spy on fs.createWriteStream to inject an error-emitting stream
    const originalCreateWriteStream = fs.createWriteStream.bind(fs);
    const createWriteStreamSpy = vi.spyOn(fs, 'createWriteStream').mockImplementationOnce((...args) => {
      const stream = originalCreateWriteStream(...(args as Parameters<typeof fs.createWriteStream>));
      // Emit error after the stream is set up
      setImmediate(() => {
        stream.emit('error', new Error('simulated write error'));
      });
      return stream;
    });

    await executor.run(task);

    createWriteStreamSpy.mockRestore();

    expect(taskManager.complete).toHaveBeenCalledOnce();
    const call = vi.mocked(taskManager.complete).mock.calls[0]!;
    expect(call[0]).toBe(task.taskId);
    expect(call[1].logFile).toBeNull();
    expect(['DONE', 'FAILED', 'TIMEOUT']).toContain(call[1].status);
  });

  it('rejects if command does not exist', async () => {
    const task = makeTask({ command: 'nonexistent-binary-xyz-abc' });
    await expect(executor.run(task)).rejects.toThrow();
  });
});
