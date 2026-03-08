import pino from 'pino';

/**
 * Create a structured logger with module name.
 * All loggers share the same base configuration:
 * - JSON output
 * - Timestamp (ISO 8601)
 * - Log level
 * - Module name
 */
export function createLogger(module: string): pino.Logger {
  return pino({
    name: module,
    level: process.env['LOG_LEVEL'] ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

// Default root logger
export const logger = createLogger('root-daemon');
