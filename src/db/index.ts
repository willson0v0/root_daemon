import Database from 'better-sqlite3';
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
export function init(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env['ROOT_DAEMON_DB'] ?? DEFAULT_DB_PATH;

  log.info({ dbPath: resolvedPath }, 'Initializing SQLite database');

  const db = new Database(resolvedPath);

  // Enable WAL mode and set synchronous=NORMAL
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create tables and indexes
  db.exec(SCHEMA_SQL);

  // Verify WAL mode is active
  const journalMode = db.pragma('journal_mode', { simple: true }) as string;
  log.info({ journalMode }, 'Database initialized');

  if (journalMode !== 'wal') {
    log.warn({ journalMode }, 'Expected WAL journal mode but got different mode');
  }

  return db;
}
