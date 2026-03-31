import { describe, it, expect } from "vitest";
import { generateSuggestions, groupAndRankSuggestions } from "../src/core/engine/suggestionEngine.js";
import type { ComparisonResult } from "../src/core/analysis/comparator.js";
import type { ScoredRepo } from "../src/core/analysis/relevanceScorer.js";
import type { ExtractedPattern } from "../src/core/analysis/patternExtractor.js";

function makePattern(overrides: Partial<ExtractedPattern> = {}): ExtractedPattern {
  return {
    type: "claude-md-section",
    content: "## Security Guidelines\n\nNever hardcode secrets.",
    sourceFile: "CLAUDE.md",
    confidence: 0.85,
    reusability: 0.8,
    title: "Security Guidelines",
    tags: ["security"],
    ...overrides,
  };
}

function makeComparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    gaps: [
      {
        patternType: "claude-md-section",
        title: "Security Guidelines",
        description: "Missing security section",
        sourcePattern: makePattern(),
        severity: "high",
      },
    ],
    enhancements: [],
    conflicts: [],
    overallFitScore: 0.7,
    sourceRepo: "owner/repo",
    ...overrides,
  };
}

function makeScoredRepo(fullName: string, score = 0.8): ScoredRepo {
  return {
    repo: {
      id: 1,
      full_name: fullName,
      name: fullName.split("/")[1] ?? "repo",
      description: "Test repo",
      html_url: `https://github.com/${fullName}`,
      stargazers_count: 500,
      forks_count: 50,
      open_issues_count: 10,
      topics: ["mcp", "claude"],
      language: "TypeScript",
      pushed_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      fork: false,
      archived: false,
      disabled: false,
      license: { key: "mit", name: "MIT" },
      owner: { login: fullName.split("/")[0] ?? "owner", type: "User" },
      default_branch: "main",
      size: 1000,
      watchers_count: 500,
      has_issues: true,
      has_wiki: false,
      has_pages: false,
      subscribers_count: 50,
    },
    category: "mcp-server",
    score,
    breakdown: {
      github_signal: 0.6,
      claude_relevance: 0.8,
      tech_match: 0.9,
      recency: 1.0,
      quality: 0.7,
      penalties: 0,
      total: score,
    },
    signals: ["mcp server indicators"],
  };
}

describe("generateSuggestions", () => {
  it("returns an empty array when given no comparisons", () => {
    const suggestions = generateSuggestions([], []);
    expect(suggestions).toEqual([]);
  });

  it("generates a micro suggestion for each gap", () => {
    const comparison = makeComparison();
    const scored = [makeScoredRepo("owner/repo", 0.8)];

    const suggestions = generateSuggestions([comparison], scored);

    const micro = suggestions.filter((s) => s.level === "micro");
    expect(micro.length).toBeGreaterThan(0);
    expect(micro[0]!.title).toContain("Security Guidelines");
  });

  it("generates a meso suggestion when a comparison has 3+ gaps", () => {
    const comparison = makeComparison({
      gaps: [
        { patternType: "claude-md-section", title: "Security", description: "", sourcePattern: makePattern(), severity: "high" },
        { patternType: "claude-md-section", title: "Testing", description: "", sourcePattern: makePattern({ title: "Testing" }), severity: "high" },
        { patternType: "claude-md-section", title: "Deployment", description: "", sourcePattern: makePattern({ title: "Deployment" }), severity: "medium" },
      ],
    });
    const scored = [makeScoredRepo("owner/repo", 0.8)];

    const suggestions = generateSuggestions([comparison], scored);

    const meso = suggestions.filter((s) => s.level === "meso");
    expect(meso.length).toBeGreaterThan(0);
  });

  it("does NOT generate a meso suggestion when fewer than 3 gaps", () => {
    const comparison = makeComparison({
      gaps: [
        { patternType: "claude-md-section", title: "Security", description: "", sourcePattern: makePattern(), severity: "high" },
        { patternType: "claude-md-section", title: "Testing", description: "", sourcePattern: makePattern({ title: "Testing" }), severity: "high" },
      ],
    });
    const scored = [makeScoredRepo("owner/repo")];

    const suggestions = generateSuggestions([comparison], scored);

    const meso = suggestions.filter((s) => s.level === "meso");
    expect(meso.length).toBe(0);
  });

  it("generates a macro suggestion when multiple comparisons all have decent fit", () => {
    const r1 = makeComparison({ sourceRepo: "owner/repo1", overallFitScore: 0.6 });
    const r2 = makeComparison({ sourceRepo: "owner/repo2", overallFitScore: 0.7 });
    const scored = [makeScoredRepo("owner/repo1", 0.9), makeScoredRepo("owner/repo2", 0.7)];

    const suggestions = generateSuggestions([r1, r2], scored);

    const macro = suggestions.filter((s) => s.level === "macro");
    expect(macro.length).toBe(1);
  });

  it("deduplicates by title keeping the highest-scoring suggestion", () => {
    // Same gap title from two repos with different scores
    const gap = {
      patternType: "claude-md-section",
      title: "Security Guidelines",
      description: "Missing",
      sourcePattern: makePattern(),
      severity: "high" as const,
    };
    const r1 = makeComparison({ sourceRepo: "low-score/repo", overallFitScore: 0.3, gaps: [gap] });
    const r2 = makeComparison({ sourceRepo: "high-score/repo", overallFitScore: 0.9, gaps: [gap] });
    // High-score repo first in scoredRepos so its confidence boost is higher
    const scored = [makeScoredRepo("high-score/repo", 0.9), makeScoredRepo("low-score/repo", 0.3)];

    const suggestions = generateSuggestions([r1, r2], scored);

    const secSuggestions = suggestions.filter((s) => s.title.includes("Security Guidelines"));
    expect(secSuggestions.length).toBe(1);
    // The surviving suggestion should reference the high-score repo
    expect(secSuggestions[0]!.sourceRepo).toBe("high-score/repo");
  });

  it("sorts suggestions by confidence × estimatedImpact descending", () => {
    const comparison = makeComparison({
      gaps: [
        { patternType: "claude-md-section", title: "Low Impact", description: "", sourcePattern: makePattern({ confidence: 0.9, reusability: 0.1 }), severity: "low" },
        { patternType: "claude-md-section", title: "High Impact", description: "", sourcePattern: makePattern({ title: "High Impact", confidence: 0.9, reusability: 0.9 }), severity: "high" },
      ],
    });
    const scored = [makeScoredRepo("owner/repo")];

    const suggestions = generateSuggestions([comparison], scored).filter((s) => s.level === "micro");

    const highIdx = suggestions.findIndex((s) => s.title.includes("High Impact"));
    const lowIdx = suggestions.findIndex((s) => s.title.includes("Low Impact"));
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("links related suggestions via shared tags", () => {
    const comparison = makeComparison({
      gaps: [
        { patternType: "claude-md-section", title: "Security Guidelines", description: "", sourcePattern: makePattern({ tags: ["security", "testing"] }), severity: "high" },
        { patternType: "claude-md-section", title: "Security Scanning", description: "", sourcePattern: makePattern({ title: "Security Scanning", tags: ["security"] }), severity: "medium" },
      ],
    });
    const scored = [makeScoredRepo("owner/repo")];

    const suggestions = generateSuggestions([comparison], scored);
    const secGuidelines = suggestions.find((s) => s.title.includes("Security Guidelines"));

    expect(secGuidelines?.relatedSuggestions.length).toBeGreaterThan(0);
  });
});

describe("groupAndRankSuggestions", () => {
  it("groups suggestions by first tag", () => {
    const comparison = makeComparison({
      gaps: [
        { patternType: "claude-md-section", title: "Security Guidelines", description: "", sourcePattern: makePattern({ tags: ["security"] }), severity: "high" },
        { patternType: "claude-md-section", title: "Testing Requirements", description: "", sourcePattern: makePattern({ title: "Testing Requirements", tags: ["testing"] }), severity: "high" },
      ],
    });
    const scored = [makeScoredRepo("owner/repo")];
    const suggestions = generateSuggestions([comparison], scored).filter((s) => s.level === "micro");

    const groups = groupAndRankSuggestions(suggestions);

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.suggestions.length > 0)).toBe(true);
  });

  it("returns groups sorted by combinedScore descending", () => {
    const comparison = makeComparison({
      gaps: [
        { patternType: "claude-md-section", title: "High Value", description: "", sourcePattern: makePattern({ title: "High Value", confidence: 0.95, reusability: 0.9, tags: ["alpha"] }), severity: "high" },
        { patternType: "claude-md-section", title: "Low Value", description: "", sourcePattern: makePattern({ title: "Low Value", confidence: 0.5, reusability: 0.3, tags: ["beta"] }), severity: "low" },
      ],
    });
    const scored = [makeScoredRepo("owner/repo")];
    const suggestions = generateSuggestions([comparison], scored).filter((s) => s.level === "micro");
    const groups = groupAndRankSuggestions(suggestions);

    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1]!.combinedScore).toBeGreaterThanOrEqual(groups[i]!.combinedScore);
    }
  });
});
