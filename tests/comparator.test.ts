import { describe, it, expect } from "vitest";
import { compareWithLocal, mergeComparisons } from "../src/core/analysis/comparator.js";
import type { ExtractedPattern } from "../src/core/analysis/patternExtractor.js";
import type { LocalDNA } from "../src/core/analysis/dnaProfiler.js";

function makePattern(overrides: Partial<ExtractedPattern> = {}): ExtractedPattern {
  return {
    type: "claude-md-section",
    content: "## Testing Requirements\n\nRun tests before every commit. Aim for 80% coverage.",
    sourceFile: "CLAUDE.md",
    confidence: 0.85,
    reusability: 0.8,
    title: "Testing Requirements",
    tags: ["testing"],
    ...overrides,
  };
}

function makeDna(overrides: Partial<LocalDNA> = {}): LocalDNA {
  return {
    languages: ["typescript"],
    frameworks: ["node"],
    hasDotClaude: true,
    hasClaudeMd: true,
    claudeMdSections: ["Development Workflow", "Coding Style"],
    claudeMdWordCount: 300,
    mcpServers: [],
    workflowStyle: "none",
    testFramework: "vitest",
    ciProvider: "none",
    ...overrides,
  };
}

describe("compareWithLocal", () => {
  it("identifies a gap when a pattern section is missing locally", () => {
    const patterns = [makePattern({ title: "Testing Requirements", tags: ["testing"] })];
    const dna = makeDna({ claudeMdSections: ["Coding Style"] });

    const result = compareWithLocal(patterns, dna, "owner/repo");

    expect(result.gaps.length).toBeGreaterThan(0);
    const gap = result.gaps.find((g) => g.title.toLowerCase().includes("testing"));
    expect(gap).toBeDefined();
  });

  it("does not create a gap when section already exists locally", () => {
    const patterns = [makePattern({ title: "Testing Requirements", tags: ["testing"] })];
    const dna = makeDna({ claudeMdSections: ["Testing Requirements", "Coding Style"] });

    const result = compareWithLocal(patterns, dna, "owner/repo");

    const gap = result.gaps.find((g) =>
      g.title.toLowerCase().includes("testing requirements")
    );
    expect(gap).toBeUndefined();
  });

  it("skips patterns with low reusability", () => {
    const patterns = [makePattern({ title: "My Specific Local Path Config", reusability: 0.2 })];
    const dna = makeDna({ claudeMdSections: [] });

    const result = compareWithLocal(patterns, dna, "owner/repo");

    // Low reusability patterns should not produce gaps
    const gap = result.gaps.find((g) => g.title.includes("My Specific"));
    expect(gap).toBeUndefined();
  });

  it("skips low-confidence patterns in the pattern loop, but high-value fallbacks still apply", () => {
    // Low-confidence pattern is excluded from the pattern loop (confidence < 0.6),
    // but "Security Guidelines" is a VALUABLE_SECTION with severity="high", so it still
    // surfaces via the fallback gap logic when missing from local sections.
    const patterns = [makePattern({ title: "Security Guidelines", confidence: 0.3 })];
    const dna = makeDna({ claudeMdSections: [] });

    const result = compareWithLocal(patterns, dna, "owner/repo");

    // The fallback for "security" (high severity) fires even without a qualifying pattern
    const gap = result.gaps.find((g) => g.title.toLowerCase().includes("security"));
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("high");
    // Fallback gap confidence is 0.5 (placeholder), not the original pattern's 0.3
    expect(gap!.sourcePattern.confidence).toBe(0.5);
  });

  it("adds high-value fallback gaps even with no patterns", () => {
    // With no patterns, high-value sections (testing, security) should still surface
    const dna = makeDna({ claudeMdSections: ["Coding Style"] });
    const result = compareWithLocal([], dna, "owner/repo");

    const highSeverityGaps = result.gaps.filter((g) => g.severity === "high");
    expect(highSeverityGaps.length).toBeGreaterThan(0);
  });

  it("identifies an enhancement when external section is substantially longer", () => {
    const longContent = "## Testing Requirements\n\n" + "word ".repeat(200);
    const patterns = [makePattern({ title: "Testing Requirements", content: longContent })];
    // Local has Testing but it's short (average ~30 words per section for 300 word / 10 sections)
    const dna = makeDna({
      claudeMdSections: ["Testing Requirements", "Coding Style"],
      claudeMdWordCount: 60,
    });

    const result = compareWithLocal(patterns, dna, "owner/repo");

    expect(result.enhancements.length).toBeGreaterThan(0);
  });

  it("detects a language conflict when external uses a different language", () => {
    const pythonPattern = makePattern({
      content: "## Coding Style\n\nUse python for all scripts. Run pylint.",
    });
    const dna = makeDna({ languages: ["typescript"] });

    const result = compareWithLocal([pythonPattern], dna, "owner/repo");

    const conflict = result.conflicts.find((c) => c.description.includes("python"));
    expect(conflict).toBeDefined();
  });

  it("returns a fit score between 0 and 1", () => {
    const patterns = [makePattern()];
    const dna = makeDna();

    const result = compareWithLocal(patterns, dna, "owner/repo");

    expect(result.overallFitScore).toBeGreaterThanOrEqual(0);
    expect(result.overallFitScore).toBeLessThanOrEqual(1);
  });

  it("includes the source repo in the result", () => {
    const result = compareWithLocal([], makeDna(), "anthropic/claude-code");
    expect(result.sourceRepo).toBe("anthropic/claude-code");
  });
});

describe("mergeComparisons", () => {
  it("deduplicates gaps across multiple comparisons", () => {
    const dna = makeDna({ claudeMdSections: [] });
    const r1 = compareWithLocal([makePattern({ title: "Security Guidelines", tags: ["security"] })], dna, "repo1");
    const r2 = compareWithLocal([makePattern({ title: "Security Guidelines", tags: ["security"] })], dna, "repo2");

    const merged = mergeComparisons([r1, r2]);

    const secGaps = merged.allGaps.filter((g) => g.title.includes("Security"));
    expect(secGaps.length).toBe(1);
  });

  it("computes average fit score across results", () => {
    const dna = makeDna();
    const r1 = compareWithLocal([], dna, "repo1");
    const r2 = compareWithLocal([], dna, "repo2");

    const merged = mergeComparisons([r1, r2]);

    expect(merged.avgFitScore).toBeCloseTo((r1.overallFitScore + r2.overallFitScore) / 2, 5);
  });

  it("returns zero avg score for empty input", () => {
    const merged = mergeComparisons([]);
    expect(merged.avgFitScore).toBe(0);
  });
});
