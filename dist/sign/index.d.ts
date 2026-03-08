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
import type Database from 'better-sqlite3';
import { TokenExpiredError, TokenInvalidError, TokenAlreadyConsumedError } from './errors.js';
export { TokenExpiredError, TokenInvalidError, TokenAlreadyConsumedError };
export interface GenerateResult {
    token: string;
    approvalUrl: string;
}
export declare class TokenService {
    private readonly hmacKey;
    private readonly db;
    /** In-memory set of consumed token hex strings for fast O(1) replay detection */
    private consumed;
    private cleanupTimer;
    constructor(hmacKey: Buffer, db: Database.Database);
    /**
     * Generate an HMAC-SHA256 token and approval URL for a task.
     *
     * @param taskId  - UUID v4 task identifier
     * @param command - Command string (must be same as stored in task)
     * @param expiresAt - Expiry time in MILLISECONDS (task.expiresAt)
     * @returns { token: hex64, approvalUrl: HTTPS URL }
     */
    generate(taskId: string, command: string, expiresAt: number): GenerateResult;
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
    verify(taskId: string, command: string, token: string, expiresSec: number): void;
    /**
     * Mark a token as consumed: writes to SQLite and updates in-memory Set.
     * Should be called immediately after verify() passes.
     */
    consume(token: string, taskId: string): Promise<void>;
    /**
     * Load consumed tokens from SQLite into memory Set.
     * Must be called on Daemon startup before processing any requests.
     */
    loadConsumed(): Promise<void>;
    /**
     * Schedule daily cleanup of consumed_tokens records older than 7 days.
     * Safe to call (tokens expire before 7 days, so they can never be replayed).
     */
    scheduleCleanup(): void;
    /**
     * Stop the cleanup timer (for graceful shutdown / testing).
     */
    stopCleanup(): void;
    private _computeHmac;
}
//# sourceMappingURL=index.d.ts.map