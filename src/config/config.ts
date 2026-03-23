import { homedir } from "os";
import { join, resolve } from "path";
import { mkdirSync } from "fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  githubToken: string | undefined;
  githubApiBase: string;
  maxReposPerScan: number;
  scanIntervalHours: number;
  minRelevanceScore: number;
  localRepoPath: string;
  dataDir: string;
  claudeMdPath: string;
  backupDir: string;
  patternDbPath: string;
  learningDbPath: string;
  logLevel: LogLevel;
  logFile: string;
}

function resolveDataDir(): string {
  const envDataDir = process.env["CLAUDE_INTEL_DATA_DIR"];
  if (envDataDir) return resolve(envDataDir);

  // Prefer ~/.claude-intel for global, fallback to .claude-intel in cwd
  const globalDir = join(homedir(), ".claude-intel");
  return globalDir;
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parseIntSafe(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return isNaN(parsed) ? fallback : parsed;
}

function parseFloatSafe(raw: string | undefined, fallback: number): number {
  const parsed = parseFloat(raw ?? String(fallback));
  return isNaN(parsed) ? fallback : parsed;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const valid: LogLevel[] = ["debug", "info", "warn", "error"];
  if (raw && valid.includes(raw as LogLevel)) return raw as LogLevel;
  return "info";
}

function buildConfig(): Config {
  const localRepoPath = resolve(process.env["LOCAL_REPO_PATH"] ?? process.cwd());
  const dataDir = resolveDataDir();
  ensureDir(dataDir);

  const backupDir = join(dataDir, "backups");
  ensureDir(backupDir);

  return {
    githubToken: process.env["GITHUB_TOKEN"],
    githubApiBase: process.env["GITHUB_API_BASE"] ?? "https://api.github.com",
    maxReposPerScan: parseIntSafe(process.env["MAX_REPOS_PER_SCAN"], 50),
    scanIntervalHours: parseIntSafe(process.env["SCAN_INTERVAL_HOURS"], 24),
    minRelevanceScore: parseFloatSafe(process.env["MIN_RELEVANCE_SCORE"], 0.6),
    localRepoPath,
    dataDir,
    claudeMdPath: join(localRepoPath, "CLAUDE.md"),
    backupDir,
    patternDbPath: join(dataDir, "patterns.db"),
    learningDbPath: join(dataDir, "learning.db"),
    logLevel: parseLogLevel(process.env["LOG_LEVEL"]),
    logFile: join(dataDir, "claude-intel.log"),
  };
}

// Singleton config instance
export const config: Config = buildConfig();

export function getConfig(): Config {
  return config;
}
