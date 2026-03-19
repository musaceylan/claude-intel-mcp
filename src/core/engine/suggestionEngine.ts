import type { ComparisonResult, Gap, Enhancement } from "../analysis/comparator.js";
import type { ScoredRepo } from "../analysis/relevanceScorer.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("suggestionEngine");

export type SuggestionLevel = "micro" | "meso" | "macro";

export interface Suggestion {
  id: string;
  level: SuggestionLevel;
  title: string;
  description: string;
  reasoning: string;
  sourceRepo: string;
  confidence: number;
  estimatedImpact: number; // 0-1
  implementation: string;
  tags: string[];
  relatedSuggestions: string[];
}

export interface SuggestionGroup {
  theme: string;
  suggestions: Suggestion[];
  combinedScore: number;
}

function generateId(title: string, source: string): string {
  const base = `${title}-${source}`.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
  return base.slice(0, 60);
}

function gapToSuggestion(gap: Gap, sourceRepo: string, repoScore: number): Suggestion {
  const impact = gap.severity === "high" ? 0.8 : gap.severity === "medium" ? 0.5 : 0.3;

  return {
    id: generateId(gap.title, sourceRepo),
    level: "micro",
    title: `Add "${gap.title}" to CLAUDE.md`,
    description: gap.description,
    reasoning: `This section was found in ${sourceRepo} (score: ${repoScore.toFixed(2)}) and appears to fill a gap in your current CLAUDE.md.`,
    sourceRepo,
    confidence: gap.sourcePattern.confidence * 0.9,
    estimatedImpact: impact,
    implementation: `Append the following section to CLAUDE.md:\n\n${gap.sourcePattern.content.slice(0, 600)}`,
    tags: gap.sourcePattern.tags,
    relatedSuggestions: [],
  };
}

function enhancementToSuggestion(enhancement: Enhancement, sourceRepo: string, repoScore: number): Suggestion {
  return {
    id: generateId(enhancement.title, sourceRepo),
    level: "micro",
    title: enhancement.title,
    description: enhancement.description,
    reasoning: `External repo ${sourceRepo} (score: ${repoScore.toFixed(2)}) has a more detailed version of this section.`,
    sourceRepo,
    confidence: enhancement.sourcePattern.confidence * 0.85,
    estimatedImpact: 0.4,
    implementation: `Consider expanding your existing "${enhancement.existingSection}" section with:\n\n${enhancement.suggestedAddition.slice(0, 600)}`,
    tags: enhancement.sourcePattern.tags,
    relatedSuggestions: [],
  };
}

function mesoSuggestion(
  comparison: ComparisonResult,
  repoScore: number
): Suggestion | null {
  if (comparison.gaps.length < 3) return null;

  return {
    id: generateId("workflow-improvement", comparison.sourceRepo),
    level: "meso",
    title: "Workflow Documentation Improvement",
    description: `${comparison.sourceRepo} has ${comparison.gaps.length} sections that could improve your development workflow documentation.`,
    reasoning: `High number of documentation gaps detected compared to ${comparison.sourceRepo}. Improving workflow documentation reduces onboarding time and increases consistency.`,
    sourceRepo: comparison.sourceRepo,
    confidence: 0.7,
    estimatedImpact: 0.6,
    implementation:
      "Review and incorporate the missing sections identified in the gap analysis. Consider running '/gsd:plan-phase' to restructure your workflow documentation.",
    tags: ["workflow", "documentation", "claude-md"],
    relatedSuggestions: [],
  };
}

function macroSuggestion(
  comparisons: ComparisonResult[],
  topRepo: ScoredRepo
): Suggestion | null {
  if (comparisons.length < 2) return null;

  const avgFit =
    comparisons.reduce((sum, c) => sum + c.overallFitScore, 0) / comparisons.length;

  if (avgFit < 0.4) return null; // Not a good fit overall

  return {
    id: generateId("architecture-review", topRepo.repo.full_name),
    level: "macro",
    title: "Architecture Alignment Review",
    description: `Multiple high-scoring repos show patterns that differ from your current architecture. Human review recommended.`,
    reasoning: `Analysis of ${comparisons.length} repositories (avg fit: ${avgFit.toFixed(2)}) reveals potential architectural improvements. These require human judgment before applying.`,
    sourceRepo: topRepo.repo.full_name,
    confidence: 0.5,
    estimatedImpact: 0.8,
    implementation:
      "Review the gap analysis and compare your project structure against top-scoring repositories. Consider architectural changes only after careful evaluation.",
    tags: ["architecture", "macro", "review-required"],
    relatedSuggestions: [],
  };
}

function groupSuggestions(suggestions: Suggestion[]): SuggestionGroup[] {
  const themeMap = new Map<string, Suggestion[]>();

  for (const suggestion of suggestions) {
    // Group by first tag or level
    const theme = suggestion.tags[0] ?? suggestion.level;
    const existing = themeMap.get(theme) ?? [];
    themeMap.set(theme, [...existing, suggestion]);
  }

  const groups: SuggestionGroup[] = [];

  for (const [theme, items] of themeMap.entries()) {
    const combinedScore = items.reduce((sum, s) => sum + s.confidence * s.estimatedImpact, 0);
    groups.push({
      theme,
      suggestions: items.sort((a, b) => b.confidence * b.estimatedImpact - a.confidence * a.estimatedImpact),
      combinedScore,
    });
  }

  return groups.sort((a, b) => b.combinedScore - a.combinedScore);
}

function linkRelatedSuggestions(suggestions: Suggestion[]): Suggestion[] {
  // Find suggestions with overlapping tags
  return suggestions.map((s) => {
    const related = suggestions
      .filter((other) => other.id !== s.id && other.tags.some((t) => s.tags.includes(t)))
      .slice(0, 3)
      .map((r) => r.id);

    return { ...s, relatedSuggestions: related };
  });
}

export function generateSuggestions(
  comparisons: ComparisonResult[],
  scoredRepos: ScoredRepo[]
): Suggestion[] {
  const all: Suggestion[] = [];
  const repoScoreMap = new Map<string, number>(
    scoredRepos.map((r) => [r.repo.full_name, r.score])
  );

  for (const comparison of comparisons) {
    const repoScore = repoScoreMap.get(comparison.sourceRepo) ?? 0.5;

    // Gap → micro suggestions
    for (const gap of comparison.gaps) {
      const suggestion = gapToSuggestion(gap, comparison.sourceRepo, repoScore);
      // Boost confidence by repo score
      all.push({ ...suggestion, confidence: suggestion.confidence * (0.5 + repoScore * 0.5) });
    }

    // Enhancement → micro suggestions
    for (const enhancement of comparison.enhancements) {
      const suggestion = enhancementToSuggestion(enhancement, comparison.sourceRepo, repoScore);
      all.push({ ...suggestion, confidence: suggestion.confidence * (0.5 + repoScore * 0.5) });
    }

    // Meso suggestions
    const meso = mesoSuggestion(comparison, repoScore);
    if (meso) all.push(meso);
  }

  // Macro suggestion based on all comparisons
  const topRepo = scoredRepos[0];
  if (topRepo) {
    const macro = macroSuggestion(comparisons, topRepo);
    if (macro) all.push(macro);
  }

  // Deduplicate by title
  const seen = new Set<string>();
  const deduped = all.filter((s) => {
    if (seen.has(s.title)) return false;
    seen.add(s.title);
    return true;
  });

  // Link related
  const linked = linkRelatedSuggestions(deduped);

  // Sort by combined score
  const sorted = linked.sort((a, b) => b.confidence * b.estimatedImpact - a.confidence * a.estimatedImpact);

  logger.info("Suggestions generated", {
    total: sorted.length,
    micro: sorted.filter((s) => s.level === "micro").length,
    meso: sorted.filter((s) => s.level === "meso").length,
    macro: sorted.filter((s) => s.level === "macro").length,
  });

  return sorted;
}

export function groupAndRankSuggestions(suggestions: Suggestion[]): SuggestionGroup[] {
  return groupSuggestions(suggestions);
}
