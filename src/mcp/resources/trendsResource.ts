import { createLogger } from "../../core/audit/logger.js";
import { getHistory, getScanSummary } from "../../core/audit/learningLog.js";
import { getTopPatterns } from "../../core/analysis/patternMemory.js";

const logger = createLogger("resource:trends");

// In-memory cache of last scan results
interface CachedScan {
  repos: unknown[];
  scanTime: string;
  totalScanned: number;
}

let latestTrendsCache: CachedScan | null = null;
let rankedReposCache: unknown[] | null = null;

export function updateTrendsCache(scanResult: CachedScan): void {
  latestTrendsCache = scanResult;
  rankedReposCache = scanResult.repos;
  logger.debug("Trends cache updated", { repos: scanResult.repos.length });
}

export function getLatestTrendsContent(): string {
  if (!latestTrendsCache) {
    const summary = getScanSummary();
    return JSON.stringify(
      {
        message: "No scan results available yet. Run scan_github_trends first.",
        lastScan: summary.last_scan,
        totalReposEverScanned: summary.total_repos_scanned,
      },
      null,
      2
    );
  }

  return JSON.stringify(latestTrendsCache, null, 2);
}

export function getRankedReposContent(): string {
  if (!rankedReposCache || rankedReposCache.length === 0) {
    const topPatterns = getTopPatterns(5);
    return JSON.stringify(
      {
        message: "No ranked repos available yet. Run scan_github_trends first.",
        topStoredPatterns: topPatterns.map((p) => ({
          title: p.title,
          type: p.type,
          sourceRepo: p.source_repo,
          reuseCount: p.reuse_count,
        })),
      },
      null,
      2
    );
  }

  return JSON.stringify({ repos: rankedReposCache }, null, 2);
}

export function getLearningHistoryContent(limit = 50): string {
  const history = getHistory(limit);
  const summary = getScanSummary();
  return JSON.stringify({ summary, history }, null, 2);
}
