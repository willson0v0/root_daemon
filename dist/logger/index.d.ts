import pino from 'pino';
/**
 * Create a structured logger with module name.
 * All loggers share the same base configuration:
 * - JSON output
 * - Timestamp (ISO 8601)
 * - Log level
 * - Module name
 */
export declare function createLogger(module: string): pino.Logger;
export declare const logger: pino.Logger<never, boolean>;
//# sourceMappingURL=index.d.ts.map