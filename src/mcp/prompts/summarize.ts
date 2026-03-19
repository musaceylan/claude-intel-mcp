import { z } from "zod";
import { getScanSummary } from "../../core/audit/learningLog.js";
import { getPatternStats } from "../../core/analysis/patternMemory.js";

export const SummarizeInputSchema = z.object({
  repos: z
    .array(
      z.object({
        full_name: z.string(),
        score: z.number(),
        category: z.string(),
        description: z.string().nullable(),
      })
    )
    .optional()
    .describe("Ranked repos to summarize"),
  gaps: z
    .array(
      z.object({
        title: z.string(),
        severity: z.string(),
        description: z.string(),
      })
    )
    .optional()
    .describe("Identified gaps to summarize"),
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        level: z.string(),
        confidence: z.number(),
        estimatedImpact: z.number(),
      })
    )
    .optional()
    .describe("Suggestions to summarize"),
});

export type SummarizeInput = z.infer<typeof SummarizeInputSchema>;

export function buildSummarizePrompt(input: SummarizeInput): string {
  const scanSummary = getScanSummary();
  const patternStats = getPatternStats();

  const reposSection =
    input.repos && input.repos.length > 0
      ? `\n## Top Ranked Repositories\n\n${input.repos
          .slice(0, 10)
          .map(
            (r, i) =>
              `${i + 1}. **${r.full_name}** (score: ${r.score.toFixed(2)}, category: ${r.category})\n   ${r.description ?? "No description"}`
          )
          .join("\n")}\n`
      : "";

  const gapsSection =
    input.gaps && input.gaps.length > 0
      ? `\n## Identified Gaps\n\n${input.gaps
          .map((g) => `- **[${g.severity.toUpperCase()}]** ${g.title}: ${g.description}`)
          .join("\n")}\n`
      : "";

  const suggestionsSection =
    input.suggestions && input.suggestions.length > 0
      ? `\n## Improvement Suggestions\n\n${input.suggestions
          .slice(0, 15)
          .map(
            (s) =>
              `- **${s.title}** [${s.level}] (confidence: ${(s.confidence * 100).toFixed(0)}%, impact: ${(s.estimatedImpact * 100).toFixed(0)}%)`
          )
          .join("\n")}\n`
      : "";

  const statsSection = `\n## Historical Stats\n\n- Total repos scanned: ${scanSummary.total_repos_scanned}\n- Total patterns stored: ${patternStats.total}\n- Patterns applied: ${scanSummary.total_applied}\n- Last scan: ${scanSummary.last_scan ?? "Never"}\n`;

  return `You are a senior developer intelligence analyst reviewing GitHub ecosystem data to improve a developer's Claude Code setup.

Based on the following data, provide a concise executive summary with actionable insights.
${reposSection}${gapsSection}${suggestionsSection}${statsSection}

## Your Task

Write a clear, structured summary that:

1. **Key Findings** (2-3 bullet points) — What are the most important patterns or trends found?
2. **Top Opportunities** (3-5 items) — What specific improvements would have the highest impact?
3. **Recommended Next Steps** — What should the developer do first, second, third?
4. **Risk Assessment** — Any patterns that should be adopted with caution?

Be specific and actionable. Avoid generic advice. Reference specific repos, patterns, and sections where relevant.

Format your response in Markdown with clear headers.`;
}
