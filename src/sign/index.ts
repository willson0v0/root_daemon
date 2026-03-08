/**
 * Token & Sign Module
 *
 * Provides HMAC-SHA256 token generation, verification, and consumption tracking.
 * Uses Node.js built-in `node:crypto` module only.
 *
 * Key design points:
 * - Token = HMAC-SHA256(hmacKey, taskId + ":" + command + ":" + expiresSec)
 * - expiresSec is Unix timestamp in SECONDS (URL param unit)
 * - task.expiresAt is in MILLISECONDS (internal unit) — always convert explicitly
 * - timingSafeEqual() is used to prevent timing attacks
 * - Consumed tokens tracked in memory Set + SQLite (survives Daemon restarts)
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { TokenExpiredError, TokenInvalidError, TokenAlreadyConsumedError } from './errors.js';
import { createLogger } from '../logger/index.js';

export { TokenExpiredError, TokenInvalidError, TokenAlreadyConsumedError };

const log = createLogger('sign');

const APPROVAL_BASE_URL = 'https://approval.willson0v0.com/approve';
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_RETENTION_DAYS = 7;

export interface GenerateResult {
  token: string;
  approvalUrl: string;
}

export class TokenService {
  private readonly hmacKey: Buffer;
  private readonly db: Database.Database;
  /** In-memory set of consumed token hex strings for fast O(1) replay detection */
  private consumed: Set<string> = new Set();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(hmacKey: Buffer, db: Database.Database) {
    this.hmacKey = hmacKey;
    this.db = db;
  }

  /**
   * Generate an HMAC-SHA256 token and approval URL for a task.
   *
   * @param taskId  - UUID v4 task identifier
   * @param command - Command string (must be same as stored in task)
   * @param expiresAt - Expiry time in MILLISECONDS (task.expiresAt)
   * @returns { token: hex64, approvalUrl: HTTPS URL }
   */
  generate(taskId: string, command: string, expiresAt: number): GenerateResult {
    const expiresSec = Math.floor(expiresAt / 1000); // ms → sec
    const token = this._computeHmac(taskId, command, expiresSec);

    const approvalUrl =
      `${APPROVAL_BASE_URL}?task_id=${encodeURIComponent(taskId)}` +
      `&token=${token}` +
      `&expires=${expiresSec}`;

    log.debug({ taskId, expiresSec }, 'Generated approval token');
    return { token, approvalUrl };
  }

  /**
   * Verify a token.
   *
   * Throws:
   *   - TokenExpiredError         if expiresSec < current Unix time (seconds)
   *   - TokenAlreadyConsumedError if token is in consumed set
   *   - TokenInvalidError         if HMAC signature does not match
   *
   * @param taskId     - UUID v4
   * @param command    - Command string (from DB)
   * @param token      - Hex token from request
   * @param expiresSec - Expiry Unix timestamp in SECONDS (from URL param)
   */
  verify(taskId: string, command: string, token: string, expiresSec: number): void {
    const nowSec = Math.floor(Date.now() / 1000);

    // Step 1: Check expiry
    if (expiresSec < nowSec) {
      throw new TokenExpiredError(`Token expired at ${expiresSec}, current time ${nowSec}`);
    }

    // Step 2: Check replay (in-memory fast path)
    if (this.consumed.has(token)) {
      throw new TokenAlreadyConsumedError();
    }

    // Step 3: Verify HMAC signature using timingSafeEqual (prevent timing attacks)
    const expected = this._computeHmac(taskId, command, expiresSec);

    let providedBuf: Buffer;
    let expectedBuf: Buffer;
    try {
      providedBuf = Buffer.from(token, 'hex');
      expectedBuf = Buffer.from(expected, 'hex');
    } catch {
      throw new TokenInvalidError('Token is not valid hex');
    }

    if (providedBuf.length !== expectedBuf.length) {
      throw new TokenInvalidError('Token length mismatch');
    }

    const isValid = crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!isValid) {
      throw new TokenInvalidError();
    }
  }

  /**
   * Mark a token as consumed: writes to SQLite and updates in-memory Set.
   * Should be called immediately after verify() passes.
   */
  async consume(token: string, taskId: string): Promise<void> {
    const consumedAt = Date.now();

    // Write to SQLite (synchronous better-sqlite3 call, wrapped in async for interface consistency)
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO consumed_tokens (token, task_id, consumed_at) VALUES (?, ?, ?)'
    );
    stmt.run(token, taskId, consumedAt);

    // Update in-memory set
    this.consumed.add(token);

    log.info({ taskId, token: token.slice(0, 8) + '...' }, 'Token consumed');
  }

  /**
   * Load consumed tokens from SQLite into memory Set.
   * Must be called on Daemon startup before processing any requests.
   */
  async loadConsumed(): Promise<void> {
    const rows = this.db.prepare('SELECT token FROM consumed_tokens').all() as { token: string }[];
    this.consumed = new Set(rows.map((r) => r.token));
    log.info({ count: this.consumed.size }, 'Loaded consumed tokens from SQLite');
  }

  /**
   * Schedule daily cleanup of consumed_tokens records older than 7 days.
   * Safe to call (tokens expire before 7 days, so they can never be replayed).
   */
  scheduleCleanup(): void {
    if (this.cleanupTimer) return; // already scheduled

    const doCleanup = () => {
      const cutoffMs = Date.now() - CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      try {
        const result = this.db
          .prepare('DELETE FROM consumed_tokens WHERE consumed_at < ?')
          .run(cutoffMs);
        log.info({ deleted: result.changes, cutoffMs }, 'Cleaned up expired consumed_tokens');
      } catch (err) {
        log.error({ err }, 'Failed to clean up consumed_tokens');
      }
    };

    this.cleanupTimer = setInterval(doCleanup, CLEANUP_INTERVAL_MS);
    // Unref so timer doesn't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    log.info('Scheduled daily consumed_tokens cleanup');
  }

  /**
   * Stop the cleanup timer (for graceful shutdown / testing).
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _computeHmac(taskId: string, command: string, expiresSec: number): string {
    const message = `${taskId}:${command}:${expiresSec}`;
    return crypto
      .createHmac('sha256', this.hmacKey)
      .update(message, 'utf8')
      .digest('hex');
  }
}
