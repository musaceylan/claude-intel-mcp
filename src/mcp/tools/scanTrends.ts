import { z } from "zod";
import { GithubCollector } from "../../core/github/githubCollector.js";
import { classifyBatch } from "../../core/analysis/repoClassifier.js";
import { scoreBatch } from "../../core/analysis/relevanceScorer.js";
import { GithubClient } from "../../core/github/githubClient.js";
import { recordEvent } from "../../core/audit/learningLog.js";
import { createLogger } from "../../core/audit/logger.js";
import pLimit from "p-limit";

const logger = createLogger("tool:scanTrends");

export const ScanTrendsInputSchema = z.object({
  topics: z
    .array(z.string())
    .optional()
    .describe("Additional search topics to include in the scan"),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.4)
    .describe("Minimum relevance score for inclusion (0-1)"),
  maxRepos: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Maximum number of repos to return"),
  includeReadme: z
    .boolean()
    .optional()
    .default(false)
    .describe("Fetch READMEs for more accurate scoring (slower)"),
});

export type ScanTrendsInput = z.infer<typeof ScanTrendsInputSchema>;

export interface RankedRepo {
  full_name: string;
  description: string | null;
  stars: number;
  language: string | null;
  topics: string[];
  pushed_at: string;
  html_url: string;
  category: string;
  score: number;
  breakdown: {
    github_signal: number;
    claude_relevance: number;
    tech_match: number;
    recency: number;
    quality: number;
    penalties: number;
    total: number;
  };
  signals: string[];
}

export interface ScanTrendsOutput {
  repos: RankedRepo[];
  scanTime: string;
  totalScanned: number;
  rateLimitRemaining: number;
}

export async function scanTrends(input: ScanTrendsInput): Promise<ScanTrendsOutput> {
  logger.info("Starting trend scan", { topics: input.topics, maxRepos: input.maxRepos });

  const client = new GithubClient();
  const collector = new GithubCollector(client);
  const scanTime = new Date().toISOString();

  // Collect repos
  const collected = await collector.collect(input.topics);
  logger.info("Collected repos", { count: collected.length });

  // Fetch READMEs if requested (rate-limit-aware)
  let readmeMap = new Map<string, string>();
  if (input.includeReadme) {
    const limit = pLimit(3);
    const tasks = collected.slice(0, 30).map((repo) =>
      limit(async () => {
        try {
          const readme = await client.getReadme(repo.owner.login, repo.name);
          return { name: repo.full_name, readme };
        } catch {
          return { name: repo.full_name, readme: "" };
        }
      })
    );

    const results = await Promise.allSettled(tasks);
    readmeMap = new Map(
      results
        .filter((r): r is PromiseFulfilledResult<{ name: string; readme: string }> => r.status === "fulfilled")
        .map((r) => [r.value.name, r.value.readme])
    );
  }

  // Classify
  const classified = classifyBatch(collected, readmeMap);

  // Score
  const scored = scoreBatch(classified, readmeMap);

  // Filter by min score
  const filtered = scored.filter((r) => r.score >= (input.minScore ?? 0.4));

  // Take top N
  const top = filtered.slice(0, input.maxRepos);

  // Record scan event
  recordEvent({
    timestamp: scanTime,
    event_type: "scan",
    repo_full_name: "",
    patterns_found: 0,
    score: top.length > 0 ? top.reduce((s, r) => s + r.score, 0) / top.length : 0,
    applied: false,
    notes: `Scanned ${collected.length} repos, ${top.length} passed threshold`,
  });

  const repos: RankedRepo[] = top.map((r) => ({
    full_name: r.repo.full_name,
    description: r.repo.description,
    stars: r.repo.stargazers_count,
    language: r.repo.language,
    topics: r.repo.topics,
    pushed_at: r.repo.pushed_at,
    html_url: r.repo.html_url,
    category: r.category,
    score: r.score,
    breakdown: r.breakdown,
    signals: r.signals,
  }));

  const rateLimit = client.getRateLimitInfo();

  return {
    repos,
    scanTime,
    totalScanned: collected.length,
    rateLimitRemaining: rateLimit.remaining,
  };
}
