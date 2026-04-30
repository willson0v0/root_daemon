/**
 * Executor - C5 Component
 *
 * Responsibilities:
 *   - fork/execve child process (no shell for single commands)
 *   - Capture stdout/stderr via PassThrough → gzip → log file
 *   - Enforce timeout watchdog (SIGTERM → 5s → SIGKILL)
 *   - Collect first 4KB snippets of stdout/stderr
 *   - Collect last 512 chars tail of stdout/stderr (for EXECUTION_RESULT)
 *   - Call TaskManager.complete() when done
 *   - Return ExecutionOutcome with exitCode, signal, snippets
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

// Tail snippet cap: last 512 chars for EXECUTION_RESULT
const TAIL_LIMIT = 512;

// Gzip flush triggers
const FLUSH_BYTES = 1 * 1024 * 1024; // 1 MB
const FLUSH_INTERVAL_MS = 1_000;      // 1 s

// Default log base (can be overridden via ROOT_DAEMON_LOG env or constructor)
const DEFAULT_LOG_BASE = process.env['ROOT_DAEMON_LOG'] ?? '/var/log/root-daemon';

// ── Execution Outcome ─────────────────────────────────────────────────────────

/**
 * Returned by Executor.run() after task execution completes.
 * Used by AgentClient to build EXECUTION_RESULT WS message.
 */
export interface ExecutionOutcome {
  exitCode: number | null;
  signal: string | null;
  /** First 4KB of stdout (for existing complete/notify usage) */
  stdoutSnippet: string;
  /** First 4KB of stderr */
  stderrSnippet: string;
  /** Last 512 chars of stdout (for EXECUTION_RESULT) */
  stdoutTail: string;
  /** Last 512 chars of stderr (for EXECUTION_RESULT) */
  stderrTail: string;
  startedAt: number;   // Unix ms
  endedAt: number;     // Unix ms
  executedOk: boolean;  // true if spawn succeeded and process ran; false if spawn/error
  logFile: string | null;
  timedOut: boolean;
}

export interface ExecutorOptions {
  /** Override log directory root (useful for tests). Default: process.env.ROOT_DAEMON_LOG ?? /var/log/root-daemon */
  logBase?: string;
  /** Notifier instance for C5→C6 result delivery (optional; skipped if not provided) */
  notifier?: Notifier;
  /**
   * Skip TaskManager.complete() after task execution.
   * Use in WS mode where tasks are synthetic (taskId='ws-<n>') and not in the in-memory DB.
   */
  skipTaskComplete?: boolean;
}

export class Executor {
  private taskManager: TaskManager;
  private logBase: string;
  private notifier: Notifier | null;
  private skipTaskComplete: boolean;

  constructor(taskManager: TaskManager, options: ExecutorOptions = {}) {
    this.taskManager = taskManager;
    this.logBase = options.logBase ?? DEFAULT_LOG_BASE;
    this.notifier = options.notifier ?? null;
    this.skipTaskComplete = options.skipTaskComplete ?? false;
  }

  /**
   * Execute `task.command` asynchronously.
   *
   * - Single-word / no-shell-metachar command → execve directly
   * - Otherwise → sh -c <command>
   * - stdout + stderr merged into gzip-compressed log file
   * - Timeout watchdog: SIGTERM, then SIGKILL after 5 s
   * - Calls TaskManager.complete() when done
   * - Returns ExecutionOutcome with exit code, signal, and snippets
   */
  async run(task: Task): Promise<ExecutionOutcome> {
    const logFile = this._logPath(task.taskId);
    const startedAt = Date.now();

    // Ensure log directory exists
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true });

    const [cmd, args] = this._parseCommand(task.command);

    log.info({ taskId: task.taskId, cmd, args }, 'Spawning child process');

    const child = spawn(cmd, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // ── Snippet accumulators (first 4KB) ────────────────────────────────────
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    // ── Tail accumulators (last 512 chars) ──────────────────────────────────
    // Rolling buffer: keep full chunks until we exceed limit, then drop old ones.
    const stdoutTailChunks: Buffer[] = [];
    const stderrTailChunks: Buffer[] = [];
    let stdoutTailBytes = 0;
    let stderrTailBytes = 0;

    /** Append to rolling tail buffer, evicting old data when over limit */
    const appendTail = (tailChunks: Buffer[], tailBytes: { value: number }, chunk: Buffer): void => {
      tailChunks.push(chunk);
      tailBytes.value += chunk.length;
      // Drop chunks from the front until we're under 2x limit (to avoid O(n) on every chunk)
      while (tailBytes.value > TAIL_LIMIT * 2 && tailChunks.length > 1) {
        const dropped = tailChunks.shift()!;
        tailBytes.value -= dropped.length;
      }
    };

    /** Flatten tail buffer to string, keeping only the last TAIL_LIMIT chars */
    const flattenTail = (tailChunks: Buffer[], tailBytes: number): string => {
      if (tailBytes <= TAIL_LIMIT) {
        return Buffer.concat(tailChunks).toString('utf8');
      }
      const combined = Buffer.concat(tailChunks);
      const str = combined.toString('utf8');
      return str.slice(-TAIL_LIMIT);
    };

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

      // Capture first-4KB snippet
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

      // Capture rolling tail (last 512 chars)
      if (stream === 'stdout') {
        appendTail(stdoutTailChunks, { value: stdoutTailBytes }, chunk);
      } else if (stream === 'stderr') {
        appendTail(stderrTailChunks, { value: stderrTailBytes }, chunk);
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
    return new Promise<ExecutionOutcome>((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(killTimer);
        clearTimeout(sigkillTimer ?? undefined);
        clearInterval(flushTimer);
        pass.end();

        // Reject so the caller knows the process couldn't even start
        reject(err);
      });

      child.on('close', (code, closeSignal) => {
        const endedAt = Date.now();
        clearTimeout(killTimer);
        if (sigkillTimer !== null) clearTimeout(sigkillTimer);
        clearInterval(flushTimer);

        // End the merged stream; wait for file write to finish
        pass.end();

        const stdoutSnippet = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrSnippet = Buffer.concat(stderrChunks).toString('utf8');
        const stdoutTail = flattenTail(stdoutTailChunks, stdoutTailBytes);
        const stderrTail = flattenTail(stderrTailChunks, stderrTailBytes);

        // If process was timed out, closeSignal is what the watchdog sent (SIGTERM/SIGKILL)
        const processCode = code !== undefined ? code : null;
        const processSignal = closeSignal ?? (timedOut ? (sigkillTimer !== null ? 'SIGKILL' : 'SIGTERM') : null);

        const status: 'DONE' | 'FAILED' | 'TIMEOUT' = timedOut
          ? 'TIMEOUT'
          : processCode === 0
            ? 'DONE'
            : 'FAILED';

        log.info({ taskId: task.taskId, status, exitCode: processCode, signal: processSignal }, 'Child process closed');

        // Build outcome to return
        const outcome: ExecutionOutcome = {
          exitCode: processCode,
          signal: processSignal as string | null,
          stdoutSnippet,
          stderrSnippet,
          stdoutTail,
          stderrTail,
          startedAt,
          endedAt,
          executedOk: true,
          logFile,
          timedOut,
        };

        fileStream.once('finish', () => {
          if (!this.skipTaskComplete) {
            try {
              this.taskManager.complete(task.taskId, {
                status,
                exitCode: processCode,
                stdoutSnippet,
                stderrSnippet,
                logFile,
              });
            } catch (err) {
              // Task may have been removed from queue (e.g., daemon is shutting down)
              log.warn({ err, taskId: task.taskId }, 'TaskManager.complete() failed');
            }
          }

          // C6: trigger Notifier.notify() for result delivery
          if (this.notifier) {
            const result = {
              taskId: task.taskId,
              status,
              exitCode: processCode ?? null,
              stdoutSnippet,
              stderrSnippet,
              logFile,
              completedAt: Date.now(),
            };
            this.notifier.notify(task, result).catch((notifyErr) => {
              log.warn({ err: notifyErr, taskId: task.taskId }, 'Notifier.notify() failed (non-fatal)');
            });
          }

          resolve(outcome);
        });

        fileStream.once('error', (err) => {
          log.error({ err, taskId: task.taskId }, 'Log file write error');
          if (!this.skipTaskComplete) {
            try {
              this.taskManager.complete(task.taskId, {
                status,
                exitCode: processCode,
                stdoutSnippet,
                stderrSnippet,
                logFile: null,
              });
            } catch (completeErr) {
              log.warn({ err: completeErr, taskId: task.taskId }, 'TaskManager.complete() failed after log write error');
            }
          }

          // C6: trigger Notifier.notify() for result delivery (logFile=null on write error)
          if (this.notifier) {
            const result = {
              taskId: task.taskId,
              status,
              exitCode: processCode ?? null,
              stdoutSnippet,
              stderrSnippet,
              logFile: null,
              completedAt: Date.now(),
            };
            this.notifier.notify(task, result).catch((notifyErr) => {
              log.warn({ err: notifyErr, taskId: task.taskId }, 'Notifier.notify() failed (non-fatal)');
            });
          }

          resolve(outcome); // Resolve anyway; log write failure is non-fatal for task lifecycle
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
