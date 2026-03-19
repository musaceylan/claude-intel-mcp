import { existsSync, readFileSync } from "fs";
import { profileLocalRepo } from "../../core/analysis/dnaProfiler.js";
import { getTopPatterns, getPatternStats } from "../../core/analysis/patternMemory.js";
import { getConfig } from "../../config/config.js";
import { createLogger } from "../../core/audit/logger.js";
import { getAppliedPatterns } from "../../core/audit/learningLog.js";

const logger = createLogger("resource:analysis");

// Cached DNA profile
let cachedDna: ReturnType<typeof profileLocalRepo> | null = null;
let dnaProfiledAt: string | null = null;

function getDnaProfile(): ReturnType<typeof profileLocalRepo> {
  // Refresh every 5 minutes or if not cached
  const fiveMinutes = 5 * 60 * 1000;
  if (!cachedDna || !dnaProfiledAt || Date.now() - new Date(dnaProfiledAt).getTime() > fiveMinutes) {
    cachedDna = profileLocalRepo();
    dnaProfiledAt = new Date().toISOString();
    logger.debug("DNA profile refreshed");
  }
  return cachedDna;
}

export function getDnaProfileContent(): string {
  const dna = getDnaProfile();
  return JSON.stringify({ profiledAt: dnaProfiledAt, dna }, null, 2);
}

export function getGapAnalysisContent(): string {
  const dna = getDnaProfile();
  const topPatterns = getTopPatterns(20);
  const stats = getPatternStats();

  // Identify sections missing from local
  const valuableSections = [
    "Testing Requirements",
    "Security Guidelines",
    "Deployment Standards",
    "Error Handling",
    "Architecture Overview",
    "Development Workflow",
    "Git Workflow",
    "Performance Guidelines",
    "Coding Style",
    "Debugging Guidelines",
  ];

  const localSectionsLower = dna.claudeMdSections.map((s) => s.toLowerCase());
  const missingSections = valuableSections.filter(
    (s) => !localSectionsLower.some((l) => l.includes(s.toLowerCase()))
  );

  return JSON.stringify(
    {
      localDna: {
        hasClaudeMd: dna.hasClaudeMd,
        sections: dna.claudeMdSections,
        wordCount: dna.claudeMdWordCount,
        languages: dna.languages,
        frameworks: dna.frameworks,
      },
      missingSections,
      patternStats: stats,
      topPatternsForReuse: topPatterns.slice(0, 10).map((p) => ({
        title: p.title,
        type: p.type,
        sourceRepo: p.source_repo,
        confidence: p.confidence,
        reuseCount: p.reuse_count,
      })),
    },
    null,
    2
  );
}

export function getCurrentClaudeMdContent(): string {
  const cfg = getConfig();
  if (!existsSync(cfg.claudeMdPath)) {
    return JSON.stringify(
      { error: `CLAUDE.md not found at ${cfg.claudeMdPath}`, path: cfg.claudeMdPath },
      null,
      2
    );
  }

  const content = readFileSync(cfg.claudeMdPath, "utf8");
  return JSON.stringify(
    {
      path: cfg.claudeMdPath,
      wordCount: content.split(/\s+/).length,
      lineCount: content.split("\n").length,
      content,
    },
    null,
    2
  );
}

export function getProposedClaudeMdContent(): string {
  const topPatterns = getTopPatterns(5);
  const applied = getAppliedPatterns();

  if (applied.length === 0 && topPatterns.length === 0) {
    return JSON.stringify(
      {
        message: "No proposed changes yet. Run scan_github_trends and compare_with_local_repo first.",
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      appliedPatterns: applied.slice(0, 10),
      topAvailablePatterns: topPatterns.slice(0, 5).map((p) => ({
        title: p.title,
        type: p.type,
        sourceRepo: p.source_repo,
        preview: p.content.slice(0, 300),
      })),
    },
    null,
    2
  );
}

export function getLearningLogContent(): string {
  const applied = getAppliedPatterns();
  const stats = getPatternStats();

  return JSON.stringify(
    {
      totalPatternsStored: stats.total,
      patternsByType: stats.byType,
      topSourceRepos: stats.topRepos,
      appliedPatterns: applied.slice(0, 20),
    },
    null,
    2
  );
}
