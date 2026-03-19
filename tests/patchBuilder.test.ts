import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to set env vars before importing config-dependent modules
const TEST_DATA_DIR = join(tmpdir(), `claude-intel-test-${Date.now()}`);
const TEST_REPO_PATH = join(tmpdir(), `claude-intel-repo-${Date.now()}`);
process.env["CLAUDE_INTEL_DATA_DIR"] = TEST_DATA_DIR;
process.env["LOCAL_REPO_PATH"] = TEST_REPO_PATH;

import { getConfig } from "../src/config/config.js";
import { buildPatch, applyPatch } from "../src/core/engine/patchBuilder.js";
import type { Suggestion } from "../src/core/engine/suggestionEngine.js";

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "test-suggestion-001",
    level: "micro",
    title: "Add Security Guidelines",
    description: "Add a security guidelines section",
    reasoning: "Security section missing from CLAUDE.md",
    sourceRepo: "anthropic/test-repo",
    confidence: 0.85,
    estimatedImpact: 0.7,
    implementation:
      "## Security Guidelines\n\nNever commit secrets. Use environment variables.\nAlways validate inputs.\n",
    tags: ["security", "guidelines"],
    relatedSuggestions: [],
    ...overrides,
  };
}

describe("patchBuilder", () => {
  let claudeMdPath: string;
  let backupDir: string;

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mkdirSync(TEST_REPO_PATH, { recursive: true });

    const cfg = getConfig();
    claudeMdPath = cfg.claudeMdPath;
    backupDir = cfg.backupDir;

    mkdirSync(backupDir, { recursive: true });

    // Clean up any existing CLAUDE.md from previous test
    if (existsSync(claudeMdPath)) {
      rmSync(claudeMdPath);
    }
  });

  afterEach(() => {
    // Clean up test CLAUDE.md
    if (existsSync(claudeMdPath)) {
      rmSync(claudeMdPath);
    }
  });

  describe("buildPatch", () => {
    it("generates a valid unified diff", () => {
      writeFileSync(claudeMdPath, "# My Project\n\n## Core Rules\n\nAlways write tests.\n");

      const suggestion = makeSuggestion();
      const patch = buildPatch(suggestion, true);

      expect(patch.diff).toBeTruthy();
      expect(patch.diff).toContain("CLAUDE.md");
      expect(patch.diff).toContain("@@");
      expect(patch.id).toBeTruthy();
    });

    it("marks patch as dry-run when dryRun=true (file not modified)", () => {
      writeFileSync(claudeMdPath, "# My Project\n\nExisting content here.\n");

      const suggestion = makeSuggestion();
      buildPatch(suggestion, true);

      // In dry-run mode, the file should NOT be modified
      const currentContent = readFileSync(claudeMdPath, "utf8");
      expect(currentContent).not.toContain("Security Guidelines");
    });

    it("never marks as destructive when only appending", () => {
      writeFileSync(claudeMdPath, "# My Project\n\n## Core Rules\n\nAlways write tests.\n");

      const suggestion = makeSuggestion();
      const patch = buildPatch(suggestion, true);

      expect(patch.isDestructive).toBe(false);
    });

    it("includes suggestion metadata in patch", () => {
      writeFileSync(claudeMdPath, "# Existing Content\n");

      const suggestion = makeSuggestion({
        title: "Add Testing Requirements",
        sourceRepo: "test/source",
      });
      const patch = buildPatch(suggestion, true);

      expect(patch.suggestion.title).toBe("Add Testing Requirements");
      expect(patch.suggestion.sourceRepo).toBe("test/source");
    });

    it("works when CLAUDE.md does not exist yet", () => {
      // Ensure file doesn't exist
      if (existsSync(claudeMdPath)) rmSync(claudeMdPath);

      const suggestion = makeSuggestion();
      const patch = buildPatch(suggestion, true);

      expect(patch.diff).toBeTruthy();
      expect(patch.appliedContent).toContain("Security Guidelines");
    });

    it("appends new content to existing CLAUDE.md", () => {
      const existing = "# My Project\n\n## Core Rules\n\nAlways write tests.\n";
      writeFileSync(claudeMdPath, existing);

      const suggestion = makeSuggestion({
        implementation: "## Security Guidelines\n\nNever commit secrets.\n",
      });
      const patch = buildPatch(suggestion, true);

      // The applied content should contain both original and new content
      expect(patch.appliedContent).toContain("Core Rules");
      expect(patch.appliedContent).toContain("Security Guidelines");
    });
  });

  describe("applyPatch", () => {
    it("writes content to CLAUDE.md when applied", () => {
      writeFileSync(claudeMdPath, "# Existing\n");

      const suggestion = makeSuggestion();
      const patch = buildPatch(suggestion, false);

      // Manually apply
      applyPatch(patch);

      const written = readFileSync(claudeMdPath, "utf8");
      expect(written).toContain("Security Guidelines");
    });

    it("creates a backup before applying", () => {
      writeFileSync(claudeMdPath, "# Original Content\n");

      const suggestion = makeSuggestion();
      const patch = buildPatch(suggestion, false);
      applyPatch(patch);

      // A backup should have been created (there will be a .bak file)
      const backupFiles = existsSync(backupDir)
        ? readdirSync(backupDir).filter((f: string) => f.endsWith(".bak"))
        : [];
      expect(backupFiles.length).toBeGreaterThan(0);
    });

    it("throws when attempting to apply a destructive patch", () => {
      const suggestion = makeSuggestion();
      const patch = buildPatch(suggestion, true);

      // Force destructive flag
      const destructivePatch = { ...patch, isDestructive: true };

      expect(() => applyPatch(destructivePatch)).toThrow(/destructive/i);
    });
  });
});
