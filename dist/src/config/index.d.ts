import type { DaemonConfig } from '../types/index.js';
/**
 * Load and validate daemon configuration.
 *
 * Config file path can be overridden via ROOT_DAEMON_CONFIG env var (for testing).
 * Secrets key path can be overridden via ROOT_DAEMON_SECRETS env var (for testing).
 *
 * On first run, generates a 32-byte random HMAC key and writes it to secrets.key (mode 0600).
 * On subsequent runs, reads the existing key.
 */
export declare function load(): DaemonConfig;
//# sourceMappingURL=index.d.ts.map