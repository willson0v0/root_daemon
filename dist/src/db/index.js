import Database from 'better-sqlite3';
import * as fs from 'fs';
import { createLogger } from '../logger/index.js';
const log = createLogger('db');
const DEFAULT_DB_PATH = '/var/lib/root-daemon/root-daemon.db';
const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS tasks (
  task_id          TEXT PRIMARY KEY,
  command          TEXT NOT NULL,
  description      TEXT NOT NULL,
  risk_hint        TEXT,
  agent_session_id TEXT NOT NULL,
  submitted_at     INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  timeout_sec      INTEGER NOT NULL DEFAULT 300,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  approved_at      INTEGER,
  completed_at     INTEGER,
  exit_code        INTEGER,
  stdout_snippet   TEXT,
  stderr_snippet   TEXT,
  log_file         TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at ON tasks(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_session ON tasks(agent_session_id);

CREATE TABLE IF NOT EXISTS consumed_tokens (
  token        TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  consumed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumed_tokens_at ON consumed_tokens(consumed_at);
`;
/**
 * Initialize SQLite database.
 *
 * DB path can be overridden via ROOT_DAEMON_DB env var (for testing).
 * Executes WAL pragma and creates tables/indexes if not present.
 *
 * @returns Database instance
 */
export function init(dbPath) {
    const resolvedPath = dbPath ?? process.env['ROOT_DAEMON_DB'] ?? DEFAULT_DB_PATH;
    log.info({ dbPath: resolvedPath }, 'Initializing SQLite database');
    const db = new Database(resolvedPath);
    // Allow group members (e.g. approval-web running as willson0v0) to read/write DB files
    // WAL mode requires both -wal and -shm to be group-writable
    try {
        const gid = parseInt(process.env['ROOT_DAEMON_DB_GID'] ?? '1001', 10); // willson0v0
        for (const suffix of ['', '-wal', '-shm']) {
            const p = resolvedPath + suffix;
            try {
                fs.chownSync(p, 0, gid);
                fs.chmodSync(p, 0o664);
            }
            catch { /* file may not exist yet */ }
        }
    }
    catch { /* non-fatal */ }
    // Enable WAL mode and set synchronous=NORMAL
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // Create tables and indexes
    db.exec(SCHEMA_SQL);
    // Verify WAL mode is active
    const journalMode = db.pragma('journal_mode', { simple: true });
    log.info({ journalMode }, 'Database initialized');
    if (journalMode !== 'wal') {
        log.warn({ journalMode }, 'Expected WAL journal mode but got different mode');
    }
    return db;
}
//# sourceMappingURL=index.js.map