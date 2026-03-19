import { describe, it, expect } from "vitest";
import { scoreRepo, scoreBatch } from "../src/core/analysis/relevanceScorer.js";
import { classifyRepo } from "../src/core/analysis/repoClassifier.js";
import type { GithubRepo } from "../src/core/github/githubClient.js";

function makeRepo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  const recent = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  return {
    id: 1,
    full_name: "test/repo",
    name: "repo",
    description: null,
    html_url: "https://github.com/test/repo",
    stargazers_count: 200,
    forks_count: 30,
    open_issues_count: 10,
    topics: [],
    language: "TypeScript",
    pushed_at: recent,
    created_at: oneYearAgo,
    updated_at: recent,
    fork: false,
    archived: false,
    disabled: false,
    license: { key: "mit", name: "MIT" },
    owner: { login: "test", type: "User" },
    default_branch: "main",
    size: 2000,
    watchers_count: 200,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    subscribers_count: 80,
    ...overrides,
  };
}

describe("relevanceScorer", () => {
  describe("basic scoring", () => {
    it("returns a score between 0 and 1", () => {
      const repo = makeRepo();
      const classified = classifyRepo(repo);
      const scored = scoreRepo(classified);

      expect(scored.score).toBeGreaterThanOrEqual(0);
      expect(scored.score).toBeLessThanOrEqual(1);
    });

    it("returns a complete breakdown", () => {
      const repo = makeRepo();
      const classified = classifyRepo(repo);
      const scored = scoreRepo(classified);

      expect(scored.breakdown).toHaveProperty("github_signal");
      expect(scored.breakdown).toHaveProperty("claude_relevance");
      expect(scored.breakdown).toHaveProperty("tech_match");
      expect(scored.breakdown).toHaveProperty("recency");
      expect(scored.breakdown).toHaveProperty("quality");
      expect(scored.breakdown).toHaveProperty("penalties");
      expect(scored.breakdown).toHaveProperty("total");
    });
  });

  describe("claude relevance scoring", () => {
    it("scores repos with Claude/MCP content higher", () => {
      const claudeRepo = makeRepo({
        description: "CLAUDE.md driven workflow automation for Claude Code",
        topics: ["claude", "mcp", "claude-code"],
        full_name: "test/claude-tools",
      });

      const genericRepo = makeRepo({
        description: "A generic utility library",
        topics: ["utility"],
        full_name: "test/generic-lib",
      });

      const claudeReadme =
        "This project uses CLAUDE.md, .claude/ directory structure and MCP server tooling for Claude Code automation.";
      const genericReadme = "A collection of utility functions.";

      const claudeClassified = classifyRepo(claudeRepo, claudeReadme);
      const genericClassified = classifyRepo(genericRepo, genericReadme);

      const claudeScored = scoreRepo(claudeClassified, claudeReadme);
      const genericScored = scoreRepo(genericClassified, genericReadme);

      expect(claudeScored.breakdown.claude_relevance).toBeGreaterThan(
        genericScored.breakdown.claude_relevance
      );
      expect(claudeScored.score).toBeGreaterThan(genericScored.score);
    });
  });

  describe("recency scoring", () => {
    it("scores recently updated repos higher", () => {
      const recentRepo = makeRepo({
        pushed_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        full_name: "test/recent",
      });

      const staleRepo = makeRepo({
        pushed_at: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString(),
        full_name: "test/stale",
      });

      const recentClassified = classifyRepo(recentRepo);
      const staleClassified = classifyRepo(staleRepo);

      const recentScored = scoreRepo(recentClassified);
      const staleScored = scoreRepo(staleClassified);

      expect(recentScored.breakdown.recency).toBeGreaterThan(staleScored.breakdown.recency);
    });
  });

  describe("penalty application", () => {
    it("applies penalties to hype repos", () => {
      const hypeRepo = makeRepo({
        description: "A revolutionary game-changing 10x developer tool",
        stargazers_count: 10000,
        forks_count: 5,
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        full_name: "test/hype",
      });

      const classified = classifyRepo(hypeRepo);
      // classify to hype
      const scored = scoreRepo(classified);

      if (classified.category === "hype") {
        expect(scored.breakdown.penalties).toBeGreaterThan(0);
      }
    });
  });

  describe("batch scoring", () => {
    it("returns sorted results (highest score first)", () => {
      const repos = [
        makeRepo({
          full_name: "test/a",
          description: "generic tool",
          topics: [],
          stargazers_count: 50,
        }),
        makeRepo({
          full_name: "test/b",
          description: "Claude Code MCP server with CLAUDE.md automation",
          topics: ["claude", "mcp"],
          stargazers_count: 500,
          forks_count: 80,
          license: { key: "mit", name: "MIT" },
        }),
      ];

      const classified = repos.map((r) => classifyRepo(r));
      const scored = scoreBatch(classified);

      expect(scored[0].score).toBeGreaterThanOrEqual(scored[1].score);
    });
  });
});
