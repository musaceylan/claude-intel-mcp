import { z } from "zod";
import { buildPatch, applyPatch } from "../../core/engine/patchBuilder.js";
import { recordEvent } from "../../core/audit/learningLog.js";
import { createLogger } from "../../core/audit/logger.js";

const logger = createLogger("tool:applyUpdates");

const SuggestionSchema = z.object({
  id: z.string(),
  level: z.enum(["micro", "meso", "macro"]),
  title: z.string(),
  description: z.string(),
  reasoning: z.string(),
  sourceRepo: z.string(),
  confidence: z.number(),
  estimatedImpact: z.number(),
  implementation: z.string(),
  tags: z.array(z.string()),
  relatedSuggestions: z.array(z.string()),
});

export const ApplyUpdatesInputSchema = z.object({
  suggestion: SuggestionSchema.describe("The suggestion to apply"),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to apply the patch — safety gate"),
});

export type ApplyUpdatesInput = z.infer<typeof ApplyUpdatesInputSchema>;

export interface ApplyUpdatesOutput {
  applied: boolean;
  backupPath: string;
  changes: string;
  patchId: string;
  targetFile: string;
  message: string;
}

export async function applyUpdates(input: ApplyUpdatesInput): Promise<ApplyUpdatesOutput> {
  if (!input.confirm) {
    logger.warn("Apply called without confirm=true", { suggestion: input.suggestion.id });
    return {
      applied: false,
      backupPath: "",
      changes: "",
      patchId: "",
      targetFile: "",
      message:
        "Patch NOT applied. You must set confirm=true to actually apply changes. Use generate_claude_md_patch with dryRun=true first to preview.",
    };
  }

  if (input.suggestion.level !== "micro") {
    logger.warn("Refusing to auto-apply non-micro suggestion", {
      level: input.suggestion.level,
      id: input.suggestion.id,
    });

    return {
      applied: false,
      backupPath: "",
      changes: "",
      patchId: "",
      targetFile: "",
      message: `Patch NOT applied. Only 'micro' level suggestions can be auto-applied. "${input.suggestion.title}" is level "${input.suggestion.level}" and requires manual review.`,
    };
  }

  logger.info("Applying patch", { suggestion: input.suggestion.id });

  // Build the real patch (not dry-run)
  const patch = buildPatch(input.suggestion, false);

  if (patch.isDestructive) {
    return {
      applied: false,
      backupPath: patch.backup,
      changes: patch.diff,
      patchId: patch.id,
      targetFile: patch.targetFile,
      message: "Patch NOT applied — it was detected as destructive (removes existing content). Review the diff manually.",
    };
  }

  try {
    applyPatch(patch);

    recordEvent({
      timestamp: new Date().toISOString(),
      event_type: "patch_applied",
      repo_full_name: input.suggestion.sourceRepo,
      patterns_found: 1,
      score: input.suggestion.confidence,
      applied: true,
      notes: `Applied: ${input.suggestion.title}`,
    });

    return {
      applied: true,
      backupPath: patch.backup,
      changes: patch.diff,
      patchId: patch.id,
      targetFile: patch.targetFile,
      message: `Successfully applied "${input.suggestion.title}" to CLAUDE.md. Backup saved at ${patch.backup}.`,
    };
  } catch (err) {
    recordEvent({
      timestamp: new Date().toISOString(),
      event_type: "patch_rejected",
      repo_full_name: input.suggestion.sourceRepo,
      patterns_found: 0,
      score: 0,
      applied: false,
      notes: `Failed to apply: ${String(err)}`,
    });

    return {
      applied: false,
      backupPath: patch.backup,
      changes: patch.diff,
      patchId: patch.id,
      targetFile: patch.targetFile,
      message: `Failed to apply patch: ${String(err)}`,
    };
  }
}
