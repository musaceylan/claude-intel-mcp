import Database from "better-sqlite3";
import { getConfig } from "../../config/config.js";
import { createLogger } from "./logger.js";

const logger = createLogger("learningLog");

export type EventType =
  | "scan"
  | "classify"
  | "extract"
  | "compare"
  | "suggest"
  | "patch_applied"
  | "patch_rejected";

export interface LearningEvent {
  id?: number;
  timestamp: string;
  event_type: EventType;
  repo_full_name: string;
  patterns_found: number;
  score: number;
  applied: boolean;
  notes: string;
}

interface LearningEventRow {
  id: number;
  timestamp: string;
  event_type: string;
  repo_full_name: string;
  patterns_found: number;
  score: number;
  applied: number;
  notes: string;
}

export interface ScanSummary {
  total_events: number;
  total_repos_scanned: number;
  total_patterns_found: number;
  total_applied: number;
  last_scan: string | null;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const { learningDbPath } = getConfig();
  db = new Database(learningDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      repo_full_name TEXT NOT NULL DEFAULT '',
      patterns_found INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_learning_events_type ON learning_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_learning_events_ts ON learning_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_learning_events_repo ON learning_events(repo_full_name);
  `);

  logger.debug("Learning log DB initialised", { path: learningDbPath });
  return db;
}

export function recordEvent(event: Omit<LearningEvent, "id">): number {
  const stmt = getDb().prepare(`
    INSERT INTO learning_events (timestamp, event_type, repo_full_name, patterns_found, score, applied, notes)
    VALUES (@timestamp, @event_type, @repo_full_name, @patterns_found, @score, @applied, @notes)
  `);

  const result = stmt.run({
    ...event,
    applied: event.applied ? 1 : 0,
  });

  return result.lastInsertRowid as number;
}

export function getHistory(limit = 100): LearningEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT id, timestamp, event_type, repo_full_name, patterns_found, score, applied, notes
       FROM learning_events ORDER BY timestamp DESC LIMIT ?`
    )
    .all(limit) as LearningEventRow[];

  return rows.map((r) => ({ ...r, event_type: r.event_type as EventType, applied: r.applied === 1 }));
}

export function getAppliedPatterns(): LearningEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT id, timestamp, event_type, repo_full_name, patterns_found, score, applied, notes
       FROM learning_events WHERE applied = 1 ORDER BY timestamp DESC`
    )
    .all() as LearningEventRow[];

  return rows.map((r) => ({ ...r, event_type: r.event_type as EventType, applied: true }));
}

export function getScanSummary(): ScanSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) as total_events,
         COUNT(DISTINCT repo_full_name) as total_repos_scanned,
         SUM(patterns_found) as total_patterns_found,
         SUM(applied) as total_applied,
         MAX(timestamp) as last_scan
       FROM learning_events`
    )
    .get() as ScanSummary & { total_patterns_found: number | null; total_applied: number | null };

  return {
    total_events: row.total_events,
    total_repos_scanned: row.total_repos_scanned,
    total_patterns_found: row.total_patterns_found ?? 0,
    total_applied: row.total_applied ?? 0,
    last_scan: row.last_scan,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
