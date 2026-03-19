import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createPatch } from "diff";
import { getConfig } from "../../config/config.js";
import type { Suggestion } from "./suggestionEngine.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("patchBuilder");

export interface Patch {
  id: string;
  targetFile: string;
  backup: string;
  diff: string;
  description: string;
  isDestructive: boolean;
  requiresReview: boolean;
  appliedContent: string; // The full file content after patch
  suggestion: Suggestion;
  createdAt: string;
}

const INTEL_COMMENT_PREFIX = "<!-- claude-intel:";

function readCurrentClaudeMd(claudeMdPath: string): string {
  if (!existsSync(claudeMdPath)) return "";
  return readFileSync(claudeMdPath, "utf8");
}

function createBackup(claudeMdPath: string, backupDir: string, patchId: string): string {
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `CLAUDE.md.${timestamp}.${patchId.slice(0, 8)}.bak`);

  if (existsSync(claudeMdPath)) {
    copyFileSync(claudeMdPath, backupPath);
  } else {
    writeFileSync(backupPath, "", "utf8");
  }

  return backupPath;
}

// Expose sourcePattern on Suggestion for internal use
interface SuggestionWithPattern extends Suggestion {
  sourcePattern?: { content: string; title?: string };
}

function buildSectionContent(suggestion: SuggestionWithPattern): string {
  const annotation = `${INTEL_COMMENT_PREFIX} source=${suggestion.sourceRepo} confidence=${suggestion.confidence.toFixed(2)} generated=${new Date().toISOString()} -->`;

  // Extract just the content to append
  const content = suggestion.sourcePattern?.content ?? suggestion.implementation;

  // Clean up the content — remove "Append the following section to CLAUDE.md:" preamble
  const cleaned = content
    .replace(/^append the following section to claude\.md:\n\n/i, "")
    .replace(/^consider expanding.*?with:\n\n/i, "")
    .trim();

  return `\n\n${annotation}\n${cleaned}`;
}

function isDestructivePatch(current: string, proposed: string): boolean {
  // A patch is destructive if it REMOVES content from the original
  const currentLines = new Set(current.split("\n").filter((l) => l.trim().length > 0));
  const proposedLines = new Set(proposed.split("\n").filter((l) => l.trim().length > 0));

  // Count how many original lines are missing in proposed
  let removedCount = 0;
  for (const line of currentLines) {
    if (!proposedLines.has(line)) removedCount++;
  }

  // Destructive if more than 5% of original content is removed
  return removedCount > currentLines.size * 0.05;
}

export function buildPatch(
  suggestion: SuggestionWithPattern,
  dryRun = true
): Patch {
  const cfg = getConfig();
  const patchId = generateId(suggestion.id);

  logger.info("Building patch", { id: patchId, suggestion: suggestion.title, dryRun });

  const current = readCurrentClaudeMd(cfg.claudeMdPath);
  const sectionToAdd = buildSectionContent(suggestion as Suggestion);

  // NEVER remove existing content — always append
  const proposed = current + sectionToAdd;

  // Generate unified diff
  const diff = createPatch(
    "CLAUDE.md",
    current,
    proposed,
    "current",
    "proposed",
    { context: 3 }
  );

  const destructive = isDestructivePatch(current, proposed);

  const backup = dryRun
    ? `${cfg.backupDir}/CLAUDE.md.dryrun.bak`
    : createBackup(cfg.claudeMdPath, cfg.backupDir, patchId);

  const patch: Patch = {
    id: patchId,
    targetFile: cfg.claudeMdPath,
    backup,
    diff,
    description: suggestion.title,
    isDestructive: destructive,
    requiresReview: suggestion.level !== "micro" || destructive,
    appliedContent: proposed,
    suggestion: suggestion as Suggestion,
    createdAt: new Date().toISOString(),
  };

  if (!dryRun && !destructive) {
    logger.warn("Patch is not dry-run — but apply() must be called explicitly to write changes");
  }

  return patch;
}

export function applyPatch(patch: Patch): void {
  if (patch.isDestructive) {
    throw new Error(
      `Refusing to apply destructive patch "${patch.id}". Manual review required.`
    );
  }

  const dir = dirname(patch.targetFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Create real backup before applying
  const cfg = getConfig();
  const realBackup = createBackup(patch.targetFile, cfg.backupDir, patch.id);
  logger.info("Backup created before applying patch", { backup: realBackup });

  writeFileSync(patch.targetFile, patch.appliedContent, "utf8");
  logger.info("Patch applied", { targetFile: patch.targetFile, patchId: patch.id });
}

export function buildPatches(suggestions: Suggestion[], dryRun = true): Patch[] {
  // Only build micro-level patches automatically
  const safesuggestions = suggestions.filter((s) => s.level === "micro");

  const patches: Patch[] = [];
  for (const suggestion of safesuggestions) {
    try {
      const patch = buildPatch(suggestion as SuggestionWithPattern, dryRun);
      patches.push(patch);
    } catch (err) {
      logger.warn("Failed to build patch", { suggestion: suggestion.title, error: String(err) });
    }
  }

  return patches;
}

function generateId(suggestionId: string): string {
  const ts = Date.now().toString(36);
  const base = suggestionId.slice(0, 20).replace(/[^a-z0-9]/g, "");
  return `${base}-${ts}`;
}
