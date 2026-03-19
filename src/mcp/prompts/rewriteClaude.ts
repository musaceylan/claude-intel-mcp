import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { getConfig } from "../../config/config.js";

export const RewriteClaudeInputSchema = z.object({
  focus: z
    .array(z.string())
    .optional()
    .describe("Specific sections to focus on (e.g. ['testing', 'security'])"),
  topRepos: z
    .array(z.string())
    .optional()
    .describe("Names of top-scoring repos to use as reference"),
  suggestions: z
    .array(z.string())
    .optional()
    .describe("Brief list of suggested improvements to incorporate"),
});

export type RewriteClaudeInput = z.infer<typeof RewriteClaudeInputSchema>;

export function buildRewriteClaudePrompt(input: RewriteClaudeInput): string {
  const cfg = getConfig();
  const currentContent = existsSync(cfg.claudeMdPath)
    ? readFileSync(cfg.claudeMdPath, "utf8")
    : "(CLAUDE.md does not exist yet — create from scratch)";

  const focusList =
    input.focus && input.focus.length > 0
      ? `Focus specifically on these areas: ${input.focus.join(", ")}.`
      : "Cover all relevant areas comprehensively.";

  const reposContext =
    input.topRepos && input.topRepos.length > 0
      ? `\nHigh-scoring reference repositories analyzed:\n${input.topRepos.map((r) => `- ${r}`).join("\n")}\n`
      : "";

  const suggestionsContext =
    input.suggestions && input.suggestions.length > 0
      ? `\nKey improvements identified:\n${input.suggestions.map((s) => `- ${s}`).join("\n")}\n`
      : "";

  return `You are a Claude Code expert who specializes in writing exceptional CLAUDE.md files.

Your task is to rewrite or improve the following CLAUDE.md file to make it more effective for Claude Code.

## Current CLAUDE.md Content

\`\`\`markdown
${currentContent}
\`\`\`
${reposContext}${suggestionsContext}

## Instructions

${focusList}

When rewriting CLAUDE.md, follow these principles:

1. **Clarity over completeness** — Each instruction should be actionable and unambiguous.
2. **Preserve existing intent** — Keep the spirit of existing sections; enhance don't replace.
3. **Add missing high-value sections** — Include sections for: testing approach, security guidelines, development workflow, error handling, and git conventions if missing.
4. **Remove boilerplate** — Cut generic advice that Claude already knows.
5. **Be specific to this project** — Reference actual file paths, commands, and conventions from the codebase.
6. **Use consistent formatting** — Markdown headers, code blocks, and bullet lists.
7. **Prioritize sections** — Most important instructions first.

## Output

Provide the complete rewritten CLAUDE.md. Start directly with the content — no preamble.
Include a brief comment at the top noting what was changed and why.`;
}
