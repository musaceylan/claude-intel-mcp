import type { GithubRepo } from "../github/githubClient.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("repoClassifier");

export type RepoCategory =
  | "mcp-server"
  | "ai-workflow"
  | "dev-tools"
  | "claude-specific"
  | "llm-tooling"
  | "template"
  | "abandoned"
  | "hype"
  | "low-quality";

export interface ClassifiedRepo {
  repo: GithubRepo;
  category: RepoCategory;
  confidence: number; // 0-1
  signals: string[];
}

const HYPE_WORDS = [
  "revolutionary",
  "game-changing",
  "10x",
  "100x",
  "world-class",
  "next-generation",
  "breakthrough",
  "disruptive",
  "paradigm-shifting",
  "mind-blowing",
  "incredible",
  "amazing developer experience",
  "the future of",
];

const ABANDONED_DAYS = 180; // 6 months
const STALE_ISSUE_DAYS = 90;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / ONE_DAY_MS;
}

function countHypeWords(text: string): number {
  const lower = text.toLowerCase();
  return HYPE_WORDS.filter((w) => lower.includes(w.toLowerCase())).length;
}

function starVelocity(repo: GithubRepo): number {
  const ageDays = Math.max(1, daysSince(repo.created_at));
  return repo.stargazers_count / ageDays;
}

function commitScore(repo: GithubRepo): "recent" | "stale" | "abandoned" {
  const days = daysSince(repo.pushed_at);
  if (days < 30) return "recent";
  if (days < ABANDONED_DAYS) return "stale";
  return "abandoned";
}

function hasMcpSignals(repo: GithubRepo): boolean {
  const text = [repo.description ?? "", ...(repo.topics ?? [])].join(" ").toLowerCase();
  return (
    text.includes("mcp") ||
    text.includes("model context protocol") ||
    text.includes("mcp-server") ||
    repo.topics.includes("mcp") ||
    repo.topics.includes("model-context-protocol")
  );
}

function hasClaudeSignals(repo: GithubRepo): boolean {
  const text = [repo.description ?? "", ...(repo.topics ?? [])].join(" ").toLowerCase();
  return (
    text.includes("claude") ||
    text.includes("claude code") ||
    text.includes("anthropic") ||
    repo.topics.includes("claude") ||
    repo.topics.includes("claude-code")
  );
}

function hasAiWorkflowSignals(repo: GithubRepo): boolean {
  const text = [repo.description ?? "", ...(repo.topics ?? [])].join(" ").toLowerCase();
  const keywords = [
    "workflow automation",
    "ai workflow",
    "llm workflow",
    "agent workflow",
    "developer automation",
    "coding assistant",
    "ai tools",
    "llm tools",
  ];
  return keywords.some((k) => text.includes(k));
}

function hasDevToolSignals(repo: GithubRepo): boolean {
  const text = [repo.description ?? "", ...(repo.topics ?? [])].join(" ").toLowerCase();
  const keywords = [
    "developer tools",
    "dev tools",
    "developer experience",
    "dx",
    "devtools",
    "productivity",
    "cli tool",
  ];
  return keywords.some((k) => text.includes(k));
}

function isTemplate(repo: GithubRepo): boolean {
  const text = [repo.description ?? "", repo.name, ...(repo.topics ?? [])].join(" ").toLowerCase();
  return (
    text.includes("template") ||
    text.includes("boilerplate") ||
    text.includes("starter") ||
    text.includes("scaffold") ||
    repo.topics.includes("template") ||
    repo.topics.includes("boilerplate")
  );
}

function isLlmTooling(repo: GithubRepo): boolean {
  const text = [repo.description ?? "", ...(repo.topics ?? [])].join(" ").toLowerCase();
  const keywords = ["llm", "large language model", "gpt", "openai", "gemini", "mistral", "ollama"];
  return keywords.some((k) => text.includes(k));
}

export function classifyRepo(repo: GithubRepo, readme = ""): ClassifiedRepo {
  const signals: string[] = [];
  const fullText = [repo.description ?? "", readme.slice(0, 2000)].join(" ");

  // --- Abandoned check (highest priority negative signal) ---
  const commitStatus = commitScore(repo);
  if (commitStatus === "abandoned") {
    signals.push("last push > 6 months ago");
    signals.push(`${Math.floor(daysSince(repo.pushed_at))} days since last commit`);

    logger.debug("Classified as abandoned", { repo: repo.full_name });
    return { repo, category: "abandoned", confidence: 0.85, signals };
  }

  // --- Hype detection ---
  const hypeCount = countHypeWords(fullText);
  const velocity = starVelocity(repo);

  if (hypeCount >= 2 && velocity > 10 && repo.forks_count < repo.stargazers_count * 0.05) {
    signals.push(`${hypeCount} hype words detected`);
    signals.push(`high star velocity without forks: ${velocity.toFixed(2)}/day`);

    logger.debug("Classified as hype", { repo: repo.full_name, hypeCount, velocity });
    return { repo, category: "hype", confidence: 0.7, signals };
  }

  // --- Low quality ---
  if (repo.stargazers_count < 20 && repo.forks_count < 3 && repo.open_issues_count === 0) {
    signals.push("very low community engagement");
    logger.debug("Classified as low-quality", { repo: repo.full_name });
    return { repo, category: "low-quality", confidence: 0.6, signals };
  }

  // --- Template ---
  if (isTemplate(repo)) {
    signals.push("template/boilerplate indicators found");
    return { repo, category: "template", confidence: 0.75, signals };
  }

  // --- Positive classifications (ordered by specificity) ---
  if (hasClaudeSignals(repo) && hasMcpSignals(repo)) {
    signals.push("claude + mcp signals");
    return { repo, category: "claude-specific", confidence: 0.9, signals };
  }

  if (hasMcpSignals(repo)) {
    signals.push("mcp server indicators");
    return { repo, category: "mcp-server", confidence: 0.85, signals };
  }

  if (hasClaudeSignals(repo)) {
    signals.push("claude/anthropic indicators");
    return { repo, category: "claude-specific", confidence: 0.8, signals };
  }

  if (hasAiWorkflowSignals(repo)) {
    signals.push("ai workflow patterns");
    return { repo, category: "ai-workflow", confidence: 0.75, signals };
  }

  if (isLlmTooling(repo)) {
    signals.push("llm tooling indicators");
    return { repo, category: "llm-tooling", confidence: 0.7, signals };
  }

  if (hasDevToolSignals(repo)) {
    signals.push("developer tool indicators");
    return { repo, category: "dev-tools", confidence: 0.65, signals };
  }

  // Fallback
  signals.push("generic repo — no strong category signals");
  return { repo, category: "dev-tools", confidence: 0.4, signals };
}

export function classifyBatch(
  repos: GithubRepo[],
  readmeMap: Map<string, string> = new Map()
): ClassifiedRepo[] {
  return repos.map((repo) => classifyRepo(repo, readmeMap.get(repo.full_name) ?? ""));
}
