import Database from 'better-sqlite3';
/**
 * Initialize SQLite database.
 *
 * DB path can be overridden via ROOT_DAEMON_DB env var (for testing).
 * Executes WAL pragma and creates tables/indexes if not present.
 *
 * @returns Database instance
 */
export declare function init(dbPath?: string): Database.Database;
//# sourceMappingURL=index.d.ts.map