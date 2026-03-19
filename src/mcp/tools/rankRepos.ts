import { z } from "zod";
import { classifyRepo } from "../../core/analysis/repoClassifier.js";
import { scoreRepo } from "../../core/analysis/relevanceScorer.js";
import { createLogger } from "../../core/audit/logger.js";
import type { GithubRepo } from "../../core/github/githubClient.js";

const logger = createLogger("tool:rankRepos");

const GithubRepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  html_url: z.string(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  topics: z.array(z.string()).default([]),
  language: z.string().nullable(),
  pushed_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  fork: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean(),
  license: z.object({ key: z.string(), name: z.string() }).nullable(),
  owner: z.object({ login: z.string(), type: z.string() }),
  default_branch: z.string(),
  size: z.number(),
  watchers_count: z.number(),
  has_issues: z.boolean(),
  has_wiki: z.boolean(),
  has_pages: z.boolean(),
  subscribers_count: z.number(),
});

export const RankReposInputSchema = z.object({
  repos: z.array(GithubRepoSchema).describe("Array of GitHub repo objects to rank"),
  readmes: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional map of full_name → readme content for better scoring"),
});

export type RankReposInput = z.infer<typeof RankReposInputSchema>;

export interface RankedRepoResult {
  full_name: string;
  rank: number;
  score: number;
  category: string;
  categoryConfidence: number;
  signals: string[];
  breakdown: {
    github_signal: number;
    claude_relevance: number;
    tech_match: number;
    recency: number;
    quality: number;
    penalties: number;
    total: number;
  };
}

export interface RankReposOutput {
  ranked: RankedRepoResult[];
  totalInput: number;
}

export async function rankRepos(input: RankReposInput): Promise<RankReposOutput> {
  logger.info("Ranking repos", { count: input.repos.length });

  const readmeMap = new Map(Object.entries(input.readmes ?? {}));

  const results: RankedRepoResult[] = (input.repos as GithubRepo[])
    .map((repo) => {
      const readme = readmeMap.get(repo.full_name) ?? "";
      const classified = classifyRepo(repo, readme);
      const scored = scoreRepo(classified, readme);

      return {
        full_name: repo.full_name,
        rank: 0, // filled after sort
        score: scored.score,
        category: classified.category,
        categoryConfidence: classified.confidence,
        signals: scored.signals,
        breakdown: scored.breakdown,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    ranked: results,
    totalInput: input.repos.length,
  };
}
