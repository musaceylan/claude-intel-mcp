import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getConfig, type LogLevel } from "../../config/config.js";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
}

function formatEntry(entry: LogEntry): string {
  const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  return `[${entry.timestamp}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.module}] ${entry.message}${ctx}`;
}

function writeToFile(line: string): void {
  try {
    const { logFile } = getConfig();
    const dir = dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logFile, line + "\n", "utf8");
  } catch {
    // Silently ignore file write errors — don't crash the server over logging
  }
}

export class Logger {
  private readonly module: string;

  constructor(module: string) {
    this.module = module;
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const cfg = getConfig();
    if (LEVEL_RANK[level] < LEVEL_RANK[cfg.logLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      context,
    };

    const line = formatEntry(entry);

    // MCP servers write to stderr, not stdout (stdout is reserved for protocol)
    process.stderr.write(line + "\n");
    writeToFile(line);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }
}

export function createLogger(module: string): Logger {
  return new Logger(module);
}
