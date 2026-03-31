import type { GithubRepo } from "../github/githubClient.js";
import type { ClassifiedRepo } from "./repoClassifier.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("relevanceScorer");

export interface RelevanceBreakdown {
  github_signal: number;
  claude_relevance: number;
  tech_match: number;
  recency: number;
  quality: number;
  penalties: number;
  total: number;
}

export interface ScoredRepo {
  repo: GithubRepo;
  category: string;
  score: number;
  breakdown: RelevanceBreakdown;
  signals: string[];
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / ONE_DAY_MS;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

// Weight constants
const W_GITHUB = 0.25;
const W_CLAUDE = 0.30;
const W_TECH = 0.20;
const W_RECENCY = 0.15;
const W_QUALITY = 0.10;

function scoreGithubSignal(repo: GithubRepo): number {
  const ageDays = Math.max(1, daysSince(repo.created_at));
  const starVelocity = repo.stargazers_count / ageDays;

  // Star velocity: 0.1/day = great, normalize to 0-1
  const velocityScore = clamp(starVelocity / 0.5, 0, 1);

  // Fork ratio: healthy is 0.05-0.3
  const forkRatio = repo.forks_count / Math.max(1, repo.stargazers_count);
  const forkScore = forkRatio > 0.02 && forkRatio < 0.5 ? 0.8 : forkRatio > 0 ? 0.5 : 0.2;

  // Contributor proxy via forks + watchers
  const engagementScore = clamp(
    (Math.log10(Math.max(1, repo.watchers_count)) / 4) * 0.5 +
      (Math.log10(Math.max(1, repo.forks_count)) / 3) * 0.5,
    0,
    1
  );

  return clamp(velocityScore * 0.4 + forkScore * 0.3 + engagementScore * 0.3);
}

function scoreClaudeRelevance(repo: GithubRepo, readme: string): number {
  const allText = [repo.description ?? "", ...(repo.topics ?? []), readme.slice(0, 3000)]
    .join(" ")
    .toLowerCase();

  const signals = [
    { pattern: "claude.md", weight: 0.3 },
    { pattern: "claude code", weight: 0.25 },
    { pattern: ".claude/", weight: 0.25 },
    { pattern: "mcp", weight: 0.2 },
    { pattern: "model context protocol", weight: 0.2 },
    { pattern: "anthropic", weight: 0.15 },
    { pattern: "workflow automation", weight: 0.1 },
    { pattern: "developer productivity", weight: 0.08 },
    { pattern: "coding assistant", weight: 0.08 },
    { pattern: "ai workflow", weight: 0.07 },
    { pattern: "llm tools", weight: 0.07 },
  ];

  let score = 0;
  for (const { pattern, weight } of signals) {
    if (allText.includes(pattern)) {
      score += weight;
    }
  }

  return clamp(score);
}

function scoreTechMatch(repo: GithubRepo): number {
  const lang = (repo.language ?? "").toLowerCase();
  const topics = repo.topics.map((t) => t.toLowerCase());
  const desc = (repo.description ?? "").toLowerCase();

  const preferredLangs: Record<string, number> = {
    typescript: 1.0,
    javascript: 0.8,
    python: 0.7,
    rust: 0.6,
    go: 0.5,
  };

  const langScore = preferredLangs[lang] ?? 0.3;

  const techSignals = [
    "node",
    "nodejs",
    "typescript",
    "fastapi",
    "nextjs",
    "react",
    "bun",
    "deno",
  ];
  const techPresent = techSignals.filter(
    (t) => topics.includes(t) || desc.includes(t)
  ).length;
  const techScore = clamp(techPresent / 4);

  return clamp(langScore * 0.7 + techScore * 0.3);
}

function scoreRecency(repo: GithubRepo): number {
  const days = daysSince(repo.pushed_at);

  if (days <= 30) return 1.0;
  if (days <= 60) return 0.8;
  if (days <= 90) return 0.6;
  if (days <= 180) return 0.4;
  return 0.1;
}

function scoreQuality(repo: GithubRepo, readme: string): number {
  let score = 0;

  // Has license
  if (repo.license) score += 0.2;

  // Has meaningful README (>200 chars)
  if (readme.length > 200) score += 0.2;

  // Has issues enabled (community)
  if (repo.has_issues) score += 0.15;

  // Has pages (docs)
  if (repo.has_pages) score += 0.1;

  // Reasonable issue count (not zero, not overwhelmingly high)
  if (repo.open_issues_count > 0 && repo.open_issues_count < 100) score += 0.15;

  // Has wiki
  if (repo.has_wiki) score += 0.1;

  // CI indicators in readme
  if (readme.toLowerCase().includes("github actions") || readme.toLowerCase().includes("ci/cd")) {
    score += 0.1;
  }

  return clamp(score);
}

function calculatePenalties(
  repo: GithubRepo,
  category: string,
  readme: string
): { total: number; reasons: string[] } {
  const penalties: Array<{ amount: number; reason: string }> = [];
  const allText = [repo.description ?? "", readme.slice(0, 2000)].join(" ").toLowerCase();

  const hypeWords = [
    "revolutionary",
    "game-changing",
    "10x",
    "100x",
    "world-class",
    "next-generation",
  ];
  const hypeCount = hypeWords.filter((w) => allText.includes(w)).length;

  if (hypeCount >= 2) {
    penalties.push({ amount: 0.2, reason: `hype language detected (${hypeCount} terms)` });
  }

  if (category === "abandoned") {
    penalties.push({ amount: 0.4, reason: "abandoned repo" });
  }

  if (category === "template") {
    penalties.push({ amount: 0.3, reason: "template/boilerplate" });
  }

  if (category === "hype") {
    penalties.push({ amount: 0.2, reason: "hype classification" });
  }

  const total = clamp(penalties.reduce((sum, p) => sum + p.amount, 0), 0, 0.8);
  return { total, reasons: penalties.map((p) => p.reason) };
}

export function scoreRepo(
  classified: ClassifiedRepo,
  readme = "",
  queryMatchCount = 1
): ScoredRepo {
  const { repo, category, signals } = classified;

  const github_signal = scoreGithubSignal(repo);
  const claude_relevance = scoreClaudeRelevance(repo, readme);
  const tech_match = scoreTechMatch(repo);
  const recency = scoreRecency(repo);
  const quality = scoreQuality(repo, readme);
  const { total: penaltyTotal, reasons: penaltyReasons } = calculatePenalties(repo, category, readme);

  const rawScore =
    github_signal * W_GITHUB +
    claude_relevance * W_CLAUDE +
    tech_match * W_TECH +
    recency * W_RECENCY +
    quality * W_QUALITY;

  // Repos appearing in multiple search queries are a strong relevance signal.
  // Bonus caps at 0.10 for repos matching 10+ distinct queries.
  const queryFreqBonus = queryMatchCount > 1 ? clamp((queryMatchCount - 1) / 9) * 0.10 : 0;

  const finalScore = clamp(rawScore - penaltyTotal + queryFreqBonus);

  const breakdown: RelevanceBreakdown = {
    github_signal: Math.round(github_signal * 1000) / 1000,
    claude_relevance: Math.round(claude_relevance * 1000) / 1000,
    tech_match: Math.round(tech_match * 1000) / 1000,
    recency: Math.round(recency * 1000) / 1000,
    quality: Math.round(quality * 1000) / 1000,
    penalties: Math.round(penaltyTotal * 1000) / 1000,
    total: Math.round(finalScore * 1000) / 1000,
  };

  logger.debug("Scored repo", { repo: repo.full_name, score: finalScore, category });

  return {
    repo,
    category,
    score: finalScore,
    breakdown,
    signals: [...signals, ...penaltyReasons],
  };
}

export function scoreBatch(
  repos: ClassifiedRepo[],
  readmeMap: Map<string, string> = new Map(),
  queryCountMap: Map<string, number> = new Map()
): ScoredRepo[] {
  const scored = repos.map((classified) =>
    scoreRepo(
      classified,
      readmeMap.get(classified.repo.full_name) ?? "",
      queryCountMap.get(classified.repo.full_name) ?? 1
    )
  );

  return scored.sort((a, b) => b.score - a.score);
}
