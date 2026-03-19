import { z } from "zod";
import { buildPatch } from "../../core/engine/patchBuilder.js";
import { createLogger } from "../../core/audit/logger.js";

const logger = createLogger("tool:generatePatch");

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

export const GeneratePatchInputSchema = z.object({
  suggestions: z
    .array(SuggestionSchema)
    .min(1)
    .describe("List of suggestions to build patches for"),
  dryRun: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), only preview the diff without writing files"),
});

export type GeneratePatchInput = z.infer<typeof GeneratePatchInputSchema>;

export interface PatchPreview {
  id: string;
  suggestionTitle: string;
  sourceRepo: string;
  diff: string;
  isDestructive: boolean;
  requiresReview: boolean;
  targetFile: string;
  level: string;
}

export interface GeneratePatchOutput {
  patches: PatchPreview[];
  dryRun: boolean;
  totalPatches: number;
  safeToApply: number;
  requiresReview: number;
}

export async function generatePatch(input: GeneratePatchInput): Promise<GeneratePatchOutput> {
  logger.info("Generating patches", { suggestions: input.suggestions.length, dryRun: input.dryRun });

  const patches: PatchPreview[] = [];

  for (const suggestion of input.suggestions) {
    try {
      const patch = buildPatch(suggestion, input.dryRun ?? true);

      patches.push({
        id: patch.id,
        suggestionTitle: suggestion.title,
        sourceRepo: suggestion.sourceRepo,
        diff: patch.diff,
        isDestructive: patch.isDestructive,
        requiresReview: patch.requiresReview,
        targetFile: patch.targetFile,
        level: suggestion.level,
      });
    } catch (err) {
      logger.warn("Failed to build patch for suggestion", {
        suggestion: suggestion.title,
        error: String(err),
      });
    }
  }

  return {
    patches,
    dryRun: input.dryRun ?? true,
    totalPatches: patches.length,
    safeToApply: patches.filter((p) => !p.isDestructive && !p.requiresReview).length,
    requiresReview: patches.filter((p) => p.requiresReview || p.isDestructive).length,
  };
}
