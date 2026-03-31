import pLimit from "p-limit";
import { GithubClient, type GithubRepo } from "./githubClient.js";
import { getConfig } from "../../config/config.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("githubCollector");

export interface CollectedRepo extends GithubRepo {
  collectedAt: string;
  searchQuery: string;
  queryMatchCount: number; // How many distinct queries returned this repo
}

const SEARCH_QUERIES = [
  "claude code mcp",
  "model context protocol server",
  "mcp server typescript",
  "claude code tools developer workflow",
  "ai development tools automation",
  "developer workflow automation llm",
  "llm tools typescript node",
  "claude code skills workflow",
  "ai coding assistant tools",
  "developer experience automation ai",
];

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function isRecentEnough(pushedAt: string): boolean {
  return Date.now() - new Date(pushedAt).getTime() < SIX_MONTHS_MS;
}

function deduplicateRepos(repos: CollectedRepo[]): CollectedRepo[] {
  const seen = new Map<string, CollectedRepo>();

  for (const repo of repos) {
    const existing = seen.get(repo.full_name);
    if (!existing) {
      seen.set(repo.full_name, { ...repo, queryMatchCount: 1 });
    } else {
      // Accumulate query match count — multi-query hits are a strong relevance signal
      seen.set(repo.full_name, {
        ...existing,
        queryMatchCount: existing.queryMatchCount + 1,
        stargazers_count: Math.max(existing.stargazers_count, repo.stargazers_count),
      });
    }
  }

  return Array.from(seen.values());
}

function passesFilter(repo: GithubRepo): boolean {
  if (repo.fork) return false;
  if (repo.archived) return false;
  if (repo.disabled) return false;
  if (repo.stargazers_count < 10) return false;
  if (!isRecentEnough(repo.pushed_at)) return false;
  return true;
}

export class GithubCollector {
  private readonly client: GithubClient;
  private readonly maxRepos: number;

  constructor(client?: GithubClient) {
    this.client = client ?? new GithubClient();
    this.maxRepos = getConfig().maxReposPerScan;
  }

  async collect(additionalQueries?: string[]): Promise<CollectedRepo[]> {
    const queries = [...SEARCH_QUERIES, ...(additionalQueries ?? [])];
    const collected: CollectedRepo[] = [];
    const limit = pLimit(3); // Max 3 concurrent API calls
    const collectedAt = new Date().toISOString();

    logger.info("Starting collection", { queries: queries.length, maxRepos: this.maxRepos });

    const tasks = queries.map((query) =>
      limit(async () => {
        try {
          const perPage = Math.min(30, Math.ceil(this.maxRepos / queries.length) + 10);
          const result = await this.client.searchRepos(query, "stars", "desc", perPage);

          const filtered = result.items
            .filter(passesFilter)
            .map((repo) => ({ ...repo, collectedAt, searchQuery: query, queryMatchCount: 1 }));

          logger.debug("Query done", {
            query,
            total: result.total_count,
            fetched: result.items.length,
            passed: filtered.length,
          });

          return filtered;
        } catch (err) {
          logger.warn("Query failed", { query, error: String(err) });
          return [];
        }
      })
    );

    const results = await Promise.all(tasks);

    for (const batch of results) {
      collected.push(...batch);
    }

    const unique = deduplicateRepos(collected);

    // Sort by stars desc, take top N
    const sorted = unique.sort((a, b) => b.stargazers_count - a.stargazers_count);
    const final = sorted.slice(0, this.maxRepos);

    logger.info("Collection complete", {
      rawCollected: collected.length,
      deduplicated: unique.length,
      returned: final.length,
    });

    return final;
  }
}
