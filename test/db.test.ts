import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init } from '../src/db/index.js';

describe('db.init()', () => {
  let tmpDir: string;
  let dbPath: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    delete process.env['ROOT_DAEMON_DB'];
  });

  it('should create database with WAL mode', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-daemon-db-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    process.env['ROOT_DAEMON_DB'] = dbPath;

    const db = init();

    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(mode).toBe('wal');

    db.close();
  });

  it('should create tasks and consumed_tokens tables', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-daemon-db-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    process.env['ROOT_DAEMON_DB'] = dbPath;

    const db = init();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('consumed_tokens');

    db.close();
  });

  it('should create indexes on tasks table', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-daemon-db-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    process.env['ROOT_DAEMON_DB'] = dbPath;

    const db = init();

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_tasks_status');
    expect(indexNames).toContain('idx_tasks_submitted_at');
    expect(indexNames).toContain('idx_tasks_agent_session');
    expect(indexNames).toContain('idx_consumed_tokens_at');

    db.close();
  });

  it('should be idempotent on repeated calls', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-daemon-db-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    process.env['ROOT_DAEMON_DB'] = dbPath;

    const db1 = init();
    db1.close();

    // Second init should not throw
    const db2 = init();
    const mode = db2.pragma('journal_mode', { simple: true }) as string;
    expect(mode).toBe('wal');
    db2.close();
  });
});
