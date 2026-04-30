import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../logger/index.js';
const log = createLogger('config');
const DEFAULT_CONFIG_PATH = '/etc/root-daemon/config.json';
const DEFAULT_SECRETS_PATH = '/etc/root-daemon/secrets.key';
/**
 * Load and validate daemon configuration.
 *
 * Config file path can be overridden via ROOT_DAEMON_CONFIG env var (for testing).
 * Secrets key path can be overridden via ROOT_DAEMON_SECRETS env var (for testing).
 *
 * On first run, generates a 32-byte random HMAC key and writes it to secrets.key (mode 0600).
 * On subsequent runs, reads the existing key.
 */
export function load() {
    const configPath = process.env['ROOT_DAEMON_CONFIG'] ?? DEFAULT_CONFIG_PATH;
    const secretsPath = process.env['ROOT_DAEMON_SECRETS'] ?? DEFAULT_SECRETS_PATH;
    // --- Load config.json ---
    if (!fs.existsSync(configPath)) {
        log.error({ configPath }, 'Config file not found');
        process.exit(1);
    }
    let raw;
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        raw = JSON.parse(content);
    }
    catch (err) {
        log.error({ configPath, err }, 'Failed to parse config file');
        process.exit(1);
    }
    // --- Validate required fields ---
    const missing = [];
    if (!raw.feishu?.appId)
        missing.push('feishu.appId');
    if (!raw.feishu?.appSecret)
        missing.push('feishu.appSecret');
    if (!raw.nova?.webhookUrl)
        missing.push('nova.webhookUrl');
    if (!raw.nova?.sessionKey)
        missing.push('nova.sessionKey');
    if (missing.length > 0) {
        log.error({ missing }, 'Config validation failed: missing required fields');
        process.exit(1);
    }
    // --- Load or generate secrets.key ---
    let hmacKey;
    if (!fs.existsSync(secretsPath)) {
        log.info({ secretsPath }, 'secrets.key not found, generating new HMAC key');
        const key = crypto.randomBytes(32);
        const keyHex = key.toString('hex');
        // Ensure parent directory exists
        const secretsDir = path.dirname(secretsPath);
        if (!fs.existsSync(secretsDir)) {
            try {
                fs.mkdirSync(secretsDir, { recursive: true, mode: 0o755 });
            }
            catch (err) {
                log.error({ secretsDir, err }, 'Failed to create secrets directory');
                process.exit(1);
            }
        }
        try {
            fs.writeFileSync(secretsPath, keyHex, { mode: 0o600, encoding: 'utf8' });
            log.info({ secretsPath }, 'HMAC key generated and saved');
        }
        catch (err) {
            log.error({ secretsPath, err }, 'Failed to write secrets.key');
            process.exit(1);
        }
        hmacKey = key;
    }
    else {
        try {
            const keyHex = fs.readFileSync(secretsPath, 'utf8').trim();
            if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
                log.error({ secretsPath }, 'secrets.key has invalid format (expected 64 hex chars)');
                process.exit(1);
            }
            hmacKey = Buffer.from(keyHex, 'hex');
            log.info({ secretsPath }, 'HMAC key loaded from secrets.key');
        }
        catch (err) {
            log.error({ secretsPath, err }, 'Failed to read secrets.key');
            process.exit(1);
        }
    }
    const config = {
        feishu: {
            appId: raw.feishu.appId,
            appSecret: raw.feishu.appSecret,
            bossChatId: raw.feishu.bossChatId,
            enabled: raw.feishu.enabled,
        },
        nova: {
            webhookUrl: raw.nova.webhookUrl,
            sessionKey: raw.nova.sessionKey,
            webhookToken: raw.nova.webhookToken,
            timeoutMs: raw.nova.timeoutMs,
        },
        db: raw.db,
        web: raw.web,
        ipc: raw.ipc,
        hmacKey,
        approval: raw.approval,
        approvalWeb: raw.approvalWeb,
    };
    log.info('Configuration loaded successfully');
    return config;
}
//# sourceMappingURL=index.js.map