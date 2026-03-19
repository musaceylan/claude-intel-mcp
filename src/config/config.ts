import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";

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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
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
    maxReposPerScan: parseInt(process.env["MAX_REPOS_PER_SCAN"] ?? "50", 10),
    scanIntervalHours: parseInt(process.env["SCAN_INTERVAL_HOURS"] ?? "24", 10),
    minRelevanceScore: parseFloat(process.env["MIN_RELEVANCE_SCORE"] ?? "0.6"),
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
