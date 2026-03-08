import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import the load function directly - it reads env vars at call time
import { load } from '../src/config/index.js';

describe('config.load()', () => {
  let tmpDir: string;
  let configPath: string;
  let secretsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-daemon-test-'));
    configPath = path.join(tmpDir, 'config.json');
    secretsPath = path.join(tmpDir, 'secrets.key');
    process.env['ROOT_DAEMON_CONFIG'] = configPath;
    process.env['ROOT_DAEMON_SECRETS'] = secretsPath;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ROOT_DAEMON_CONFIG'];
    delete process.env['ROOT_DAEMON_SECRETS'];
  });

  function writeValidConfig() {
    fs.writeFileSync(configPath, JSON.stringify({
      feishu: { appId: 'test-app-id', appSecret: 'test-app-secret' },
      nova: { webhookUrl: 'https://example.com/hook', sessionKey: 'test-session-key' },
    }));
  }

  it('should load a valid config and return typed config object', () => {
    writeValidConfig();
    const config = load();

    expect(config.feishu.appId).toBe('test-app-id');
    expect(config.feishu.appSecret).toBe('test-app-secret');
    expect(config.nova.webhookUrl).toBe('https://example.com/hook');
    expect(config.nova.sessionKey).toBe('test-session-key');
    expect(config.hmacKey).toBeInstanceOf(Buffer);
    expect(config.hmacKey.length).toBe(32);
  });

  it('should generate secrets.key on first run (mode 0600)', () => {
    writeValidConfig();
    load();

    expect(fs.existsSync(secretsPath)).toBe(true);

    const stat = fs.statSync(secretsPath);
    // Check file permissions: mode & 0o777 should be 0o600
    expect(stat.mode & 0o777).toBe(0o600);

    const content = fs.readFileSync(secretsPath, 'utf8').trim();
    expect(content).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('should not overwrite existing secrets.key on repeated runs', () => {
    writeValidConfig();

    // First run
    const config1 = load();
    const key1 = config1.hmacKey.toString('hex');

    // Second run
    const config2 = load();
    const key2 = config2.hmacKey.toString('hex');

    expect(key1).toBe(key2);
  });

  it('should exit process when config file does not exist', () => {
    // Don't write config file
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error('process.exit called');
    });

    try {
      expect(() => load()).toThrow('process.exit called');
    } finally {
      mockExit.mockRestore();
    }
  });

  it('should exit process when required fields are missing', () => {
    // Write config with missing fields
    fs.writeFileSync(configPath, JSON.stringify({
      feishu: { appId: 'only-app-id' },
      // missing appSecret, nova fields
    }));

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      throw new Error('process.exit called');
    });

    try {
      expect(() => load()).toThrow('process.exit called');
    } finally {
      mockExit.mockRestore();
    }
  });

  it('should load hmacKey from existing secrets.key', () => {
    writeValidConfig();

    // Pre-create secrets.key
    fs.writeFileSync(secretsPath, 'a'.repeat(64), { mode: 0o600 });

    const config = load();

    expect(config.hmacKey.toString('hex')).toBe('a'.repeat(64));
    expect(config.hmacKey.length).toBe(32);
  });
});
