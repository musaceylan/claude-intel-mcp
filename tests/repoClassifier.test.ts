import { describe, it, expect } from "vitest";
import { classifyRepo, classifyBatch } from "../src/core/analysis/repoClassifier.js";
import type { GithubRepo } from "../src/core/github/githubClient.js";

function makeRepo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  const now = new Date().toISOString();
  const recent = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  return {
    id: 1,
    full_name: "test/repo",
    name: "repo",
    description: null,
    html_url: "https://github.com/test/repo",
    stargazers_count: 100,
    forks_count: 10,
    open_issues_count: 5,
    topics: [],
    language: "TypeScript",
    pushed_at: recent,
    created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: recent,
    fork: false,
    archived: false,
    disabled: false,
    license: null,
    owner: { login: "test", type: "User" },
    default_branch: "main",
    size: 1000,
    watchers_count: 100,
    has_issues: true,
    has_wiki: true,
    has_pages: false,
    subscribers_count: 50,
    ...overrides,
  };
}

describe("repoClassifier", () => {
  describe("hype detection", () => {
    it("classifies repo with multiple hype words and suspicious star/fork ratio as hype", () => {
      const repo = makeRepo({
        description: "A revolutionary game-changing 10x developer experience",
        stargazers_count: 5000,
        forks_count: 10, // very low fork ratio
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // very new
      });

      const result = classifyRepo(repo);
      expect(result.category).toBe("hype");
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.signals.some((s) => s.includes("hype"))).toBe(true);
    });

    it("does not classify legitimate repo as hype", () => {
      const repo = makeRepo({
        description: "MCP server for Claude Code with TypeScript support",
        stargazers_count: 500,
        forks_count: 80,
        created_at: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const result = classifyRepo(repo);
      expect(result.category).not.toBe("hype");
    });
  });

  describe("abandoned detection", () => {
    it("classifies repo with no activity in 6+ months as abandoned", () => {
      const sevenMonthsAgo = new Date(
        Date.now() - 7 * 30 * 24 * 60 * 60 * 1000
      ).toISOString();

      const repo = makeRepo({
        pushed_at: sevenMonthsAgo,
        description: "Some old tool",
      });

      const result = classifyRepo(repo);
      expect(result.category).toBe("abandoned");
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.signals.some((s) => s.includes("6 months") || s.includes("last push"))).toBe(true);
    });

    it("does not classify recently active repo as abandoned", () => {
      const tenDaysAgo = new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000
      ).toISOString();

      const repo = makeRepo({ pushed_at: tenDaysAgo });
      const result = classifyRepo(repo);
      expect(result.category).not.toBe("abandoned");
    });
  });

  describe("mcp-server classification", () => {
    it("classifies repo with MCP topic (no claude) as mcp-server", () => {
      const repo = makeRepo({
        topics: ["mcp", "typescript", "model-context-protocol"],
        description: "MCP server for developer tools",
      });

      const result = classifyRepo(repo);
      expect(result.category).toBe("mcp-server");
      expect(result.confidence).toBeGreaterThan(0.7);
    });

    it("classifies repo with 'model context protocol' in description as mcp-server", () => {
      const repo = makeRepo({
        description: "A model context protocol server implementation",
      });

      const result = classifyRepo(repo);
      expect(result.category).toBe("mcp-server");
    });

    it("classifies claude + mcp repo as claude-specific (more specific)", () => {
      const repo = makeRepo({
        topics: ["claude", "mcp", "claude-code"],
        description: "Claude Code MCP server",
      });

      const result = classifyRepo(repo);
      expect(result.category).toBe("claude-specific");
      expect(result.confidence).toBeGreaterThan(0.85);
    });
  });

  describe("template detection", () => {
    it("classifies template repos correctly", () => {
      const repo = makeRepo({
        name: "mcp-server-template",
        description: "A boilerplate template for MCP servers",
        topics: ["template", "boilerplate"],
      });

      const result = classifyRepo(repo);
      expect(result.category).toBe("template");
    });
  });

  describe("batch classification", () => {
    it("classifies all repos in a batch", () => {
      const repos = [
        makeRepo({ topics: ["mcp"], full_name: "a/mcp-server" }),
        makeRepo({
          pushed_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
          full_name: "b/old-thing",
        }),
      ];

      const results = classifyBatch(repos);
      expect(results).toHaveLength(2);
      expect(results[0].category).toBe("mcp-server");
      expect(results[1].category).toBe("abandoned");
    });
  });
});
