/**
 * Executor - C5 Component
 *
 * Responsibilities:
 *   - fork/execve child process (no shell for single commands)
 *   - Capture stdout/stderr via PassThrough → gzip → log file
 *   - Enforce timeout watchdog (SIGTERM → 5s → SIGKILL)
 *   - Collect first 4KB snippets of stdout/stderr
 *   - Call TaskManager.complete() when done
 *   - TODO (C6): trigger Notifier.notify()
 */

import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger/index.js';
import type { Task } from '../types/index.js';
import type { TaskManager } from '../task/index.js';
import type { Notifier } from '../notifier/index.js';

const log = createLogger('executor');

// Shell metacharacters that require `sh -c`
const SHELL_META_RE = /[|&;<>$`(){}*?[\]~\n]/;

// Snippet cap: first 4KB of each stream
const SNIPPET_LIMIT = 4 * 1024;

// Gzip flush triggers
const FLUSH_BYTES = 1 * 1024 * 1024; // 1 MB
const FLUSH_INTERVAL_MS = 1_000;      // 1 s

// Default log base (can be overridden via constructor for testing)
const DEFAULT_LOG_BASE = '/var/log/root-daemon';

export interface ExecutorOptions {
  /** Override log directory root (useful for tests). Default: /var/log/root-daemon */
  logBase?: string;
  /** Notifier instance for C5→C6 result delivery (optional; skipped if not provided) */
  notifier?: Notifier;
}

export class Executor {
  private taskManager: TaskManager;
  private logBase: string;
  private notifier: Notifier | null;

  constructor(taskManager: TaskManager, options: ExecutorOptions = {}) {
    this.taskManager = taskManager;
    this.logBase = options.logBase ?? DEFAULT_LOG_BASE;
    this.notifier = options.notifier ?? null;
  }

  /**
   * Execute `task.command` asynchronously.
   *
   * - Single-word / no-shell-metachar command → execve directly
   * - Otherwise → sh -c <command>
   * - stdout + stderr merged into gzip-compressed log file
   * - Timeout watchdog: SIGTERM, then SIGKILL after 5 s
   * - Calls TaskManager.complete() with final status + snippets
   */
  async run(task: Task): Promise<void> {
    const logFile = this._logPath(task.taskId);

    // Ensure log directory exists
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true });

    const [cmd, args] = this._parseCommand(task.command);

    log.info({ taskId: task.taskId, cmd, args }, 'Spawning child process');

    const child = spawn(cmd, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // ── Snippet accumulators ────────────────────────────────────────────────
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    // ── PassThrough → Gzip → file ───────────────────────────────────────────
    const pass = new PassThrough();
    const gz = createGzip();
    const fileStream = fs.createWriteStream(logFile);

    pass.pipe(gz).pipe(fileStream);

    let bytesSinceFlush = 0;

    const flushTimer = setInterval(() => {
      gz.flush();
    }, FLUSH_INTERVAL_MS);

    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      // Write to merged log stream
      pass.write(chunk);
      bytesSinceFlush += chunk.length;
      if (bytesSinceFlush >= FLUSH_BYTES) {
        gz.flush();
        bytesSinceFlush = 0;
      }

      // Capture snippet
      if (stream === 'stdout' && stdoutBytes < SNIPPET_LIMIT) {
        const remaining = SNIPPET_LIMIT - stdoutBytes;
        const slice = chunk.subarray(0, remaining);
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
      } else if (stream === 'stderr' && stderrBytes < SNIPPET_LIMIT) {
        const remaining = SNIPPET_LIMIT - stderrBytes;
        const slice = chunk.subarray(0, remaining);
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => onData('stdout', chunk));
    child.stderr!.on('data', (chunk: Buffer) => onData('stderr', chunk));

    // ── Timeout watchdog ────────────────────────────────────────────────────
    let timedOut = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutMs = (task.timeoutSec ?? 300) * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      log.warn({ taskId: task.taskId, timeoutSec: task.timeoutSec }, 'Timeout: sending SIGTERM');
      try { child.kill('SIGTERM'); } catch { /* already exited */ }

      sigkillTimer = setTimeout(() => {
        if (!child.killed) {
          log.warn({ taskId: task.taskId }, 'Still alive after SIGTERM: sending SIGKILL');
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
      }, 5_000);
    }, timeoutMs);

    // ── Await process close ─────────────────────────────────────────────────
    await new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(killTimer);
        clearTimeout(sigkillTimer ?? undefined);
        clearInterval(flushTimer);
        pass.end();
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (sigkillTimer !== null) clearTimeout(sigkillTimer);
        clearInterval(flushTimer);

        // End the merged stream; wait for file write to finish
        pass.end();

        const stdoutSnippet = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrSnippet = Buffer.concat(stderrChunks).toString('utf8');

        const status: 'DONE' | 'FAILED' | 'TIMEOUT' = timedOut
          ? 'TIMEOUT'
          : code === 0
            ? 'DONE'
            : 'FAILED';

        log.info({ taskId: task.taskId, status, exitCode: code }, 'Child process closed');

        fileStream.once('finish', () => {
          try {
            this.taskManager.complete(task.taskId, {
              status,
              exitCode: code,
              stdoutSnippet,
              stderrSnippet,
              logFile,
            });
          } catch (err) {
            // Task may have been removed from queue (e.g., daemon is shutting down)
            log.warn({ err, taskId: task.taskId }, 'TaskManager.complete() failed');
          }

          // C6: trigger Notifier.notify() for result delivery
          if (this.notifier) {
            const result = {
              taskId: task.taskId,
              status,
              exitCode: code ?? null,
              stdoutSnippet,
              stderrSnippet,
              logFile,
              completedAt: Date.now(),
            };
            this.notifier.notify(task, result).catch((notifyErr) => {
              log.warn({ err: notifyErr, taskId: task.taskId }, 'Notifier.notify() failed (non-fatal)');
            });
          }

          resolve();
        });

        fileStream.once('error', (err) => {
          log.error({ err, taskId: task.taskId }, 'Log file write error');
          try {
            this.taskManager.complete(task.taskId, {
              status,
              exitCode: code,
              stdoutSnippet,
              stderrSnippet,
              logFile: null,
            });
          } catch (completeErr) {
            log.warn({ err: completeErr, taskId: task.taskId }, 'TaskManager.complete() failed after log write error');
          }

          // C6: trigger Notifier.notify() for result delivery (logFile=null on write error)
          if (this.notifier) {
            const result = {
              taskId: task.taskId,
              status,
              exitCode: code ?? null,
              stdoutSnippet,
              stderrSnippet,
              logFile: null,
              completedAt: Date.now(),
            };
            this.notifier.notify(task, result).catch((notifyErr) => {
              log.warn({ err: notifyErr, taskId: task.taskId }, 'Notifier.notify() failed (non-fatal)');
            });
          }

          resolve(); // Resolve anyway; log write failure is non-fatal for task lifecycle
        });
      });
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Parse command string into [executable, args[]].
   *
   * - If command contains shell metacharacters → delegate to `sh -c`
   * - Otherwise → split on whitespace and execve directly (no shell)
   */
  private _parseCommand(command: string): [string, string[]] {
    if (SHELL_META_RE.test(command)) {
      return ['sh', ['-c', command]];
    }
    const parts = command.trim().split(/\s+/);
    return [parts[0]!, parts.slice(1)];
  }

  /**
   * Return gzip log file path: <logBase>/<YYYY-MM-DD>/<taskId>.log.gz
   */
  private _logPath(taskId: string): string {
    const dateStr = new Date().toISOString().slice(0, 10);
    return path.join(this.logBase, dateStr, `${taskId}.log.gz`);
  }
}
