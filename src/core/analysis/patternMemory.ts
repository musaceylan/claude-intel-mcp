import Database from "better-sqlite3";
import { createHash } from "crypto";
import { getConfig } from "../../config/config.js";
import type { ExtractedPattern } from "./patternExtractor.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("patternMemory");

export interface StoredPattern extends ExtractedPattern {
  id: number;
  hash: string;
  source_repo: string;
  reuse_count: number;
  first_seen: string;
  last_seen: string;
}

export interface PatternRow {
  id: number;
  hash: string;
  type: string;
  source_repo: string;
  content: string;
  confidence: number;
  reusability: number;
  title: string;
  tags: string;
  reuse_count: number;
  first_seen: string;
  last_seen: string;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const { patternDbPath } = getConfig();
  db = new Database(patternDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      source_repo TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      reusability REAL NOT NULL DEFAULT 0.5,
      title TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      reuse_count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patterns_hash ON patterns(hash);
    CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(type);
    CREATE INDEX IF NOT EXISTS idx_patterns_source ON patterns(source_repo);
    CREATE INDEX IF NOT EXISTS idx_patterns_reuse ON patterns(reuse_count);

    CREATE TABLE IF NOT EXISTS processed_repos (
      full_name TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
  `);

  logger.debug("Pattern DB initialised", { path: patternDbPath });
  return db;
}

function hashPattern(pattern: ExtractedPattern): string {
  const key = `${pattern.type}::${pattern.title}::${pattern.content.slice(0, 500)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function rowToStoredPattern(row: PatternRow): StoredPattern {
  return {
    id: row.id,
    hash: row.hash,
    type: row.type as StoredPattern["type"],
    source_repo: row.source_repo,
    content: row.content,
    confidence: row.confidence,
    reusability: row.reusability,
    title: row.title,
    tags: JSON.parse(row.tags) as string[],
    reuse_count: row.reuse_count,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    sourceFile: "",
  };
}

export function storePattern(pattern: ExtractedPattern, sourceRepo: string): StoredPattern {
  const hash = hashPattern(pattern);
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(pattern.tags ?? []);

  const existing = getDb()
    .prepare("SELECT * FROM patterns WHERE hash = ?")
    .get(hash) as PatternRow | undefined;

  if (existing) {
    // Update last_seen and bump reuse_count
    getDb()
      .prepare(
        "UPDATE patterns SET last_seen = ?, reuse_count = reuse_count + 1 WHERE hash = ?"
      )
      .run(now, hash);

    return rowToStoredPattern({ ...existing, last_seen: now, reuse_count: existing.reuse_count + 1 });
  }

  const stmt = getDb().prepare(`
    INSERT INTO patterns (hash, type, source_repo, content, confidence, reusability, title, tags, reuse_count, first_seen, last_seen)
    VALUES (@hash, @type, @source_repo, @content, @confidence, @reusability, @title, @tags, 0, @first_seen, @last_seen)
  `);

  const result = stmt.run({
    hash,
    type: pattern.type,
    source_repo: sourceRepo,
    content: pattern.content,
    confidence: pattern.confidence,
    reusability: pattern.reusability,
    title: pattern.title,
    tags: tagsJson,
    first_seen: now,
    last_seen: now,
  });

  const row = getDb()
    .prepare("SELECT * FROM patterns WHERE id = ?")
    .get(result.lastInsertRowid) as PatternRow;

  return rowToStoredPattern(row);
}

export function findSimilar(pattern: ExtractedPattern, limit = 5): StoredPattern[] {
  // Exact hash match first
  const hash = hashPattern(pattern);
  const exact = getDb()
    .prepare("SELECT * FROM patterns WHERE hash = ?")
    .get(hash) as PatternRow | undefined;

  if (exact) return [rowToStoredPattern(exact)];

  // Type-based similarity
  const rows = getDb()
    .prepare(
      "SELECT * FROM patterns WHERE type = ? ORDER BY reuse_count DESC, confidence DESC LIMIT ?"
    )
    .all(pattern.type, limit) as PatternRow[];

  return rows.map(rowToStoredPattern);
}

export function markReused(id: number): void {
  getDb()
    .prepare("UPDATE patterns SET reuse_count = reuse_count + 1, last_seen = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function getTopPatterns(limit = 20): StoredPattern[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM patterns
       ORDER BY (reuse_count * reusability * confidence) DESC
       LIMIT ?`
    )
    .all(limit) as PatternRow[];

  return rows.map(rowToStoredPattern);
}

export function hasProcessed(repoFullName: string): boolean {
  const row = getDb()
    .prepare("SELECT full_name FROM processed_repos WHERE full_name = ?")
    .get(repoFullName);
  return row !== undefined;
}

export function markProcessed(repoFullName: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO processed_repos (full_name, processed_at) VALUES (?, ?)"
    )
    .run(repoFullName, new Date().toISOString());
}

export function getPatternStats(): {
  total: number;
  byType: Record<string, number>;
  topRepos: Array<{ source_repo: string; count: number }>;
} {
  const total = (
    getDb().prepare("SELECT COUNT(*) as cnt FROM patterns").get() as { cnt: number }
  ).cnt;

  const byTypeRows = getDb()
    .prepare("SELECT type, COUNT(*) as cnt FROM patterns GROUP BY type")
    .all() as Array<{ type: string; cnt: number }>;

  const byType: Record<string, number> = {};
  for (const row of byTypeRows) byType[row.type] = row.cnt;

  const topRepos = getDb()
    .prepare(
      "SELECT source_repo, COUNT(*) as count FROM patterns GROUP BY source_repo ORDER BY count DESC LIMIT 10"
    )
    .all() as Array<{ source_repo: string; count: number }>;

  return { total, byType, topRepos };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
