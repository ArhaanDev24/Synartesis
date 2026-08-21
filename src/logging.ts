import pino, { type Logger } from "pino";

export type { Logger };

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

/**
 * Always fd 2. stdout carries MCP protocol frames, and a single stray log line
 * on it corrupts the session for every client. Synchronous so that the last
 * lines before an exit are not lost, which is exactly when they matter.
 */
export function createLogger(level: LogLevel): Logger {
  return pino(
    { level, base: { name: "synartesis" } },
    pino.destination({ dest: 2, sync: true }),
  );
}
