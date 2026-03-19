import type { Suggestion } from "./suggestionEngine.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("updatePlanner");

export interface UpdateStep {
  order: number;
  suggestion: Suggestion;
  action: string;
  estimatedEffort: "trivial" | "small" | "medium" | "large";
  risks: string[];
  automated: boolean;
}

export interface UpdatePhase {
  phase: number;
  name: string;
  description: string;
  steps: UpdateStep[];
  totalEstimatedMinutes: number;
}

export interface UpdatePlan {
  id: string;
  createdAt: string;
  phases: UpdatePhase[];
  totalSteps: number;
  automatedSteps: number;
  manualSteps: number;
  estimatedTotalMinutes: number;
  summary: string;
}

const EFFORT_MINUTES: Record<UpdateStep["estimatedEffort"], number> = {
  trivial: 2,
  small: 10,
  medium: 30,
  large: 120,
};

function estimateEffort(suggestion: Suggestion): UpdateStep["estimatedEffort"] {
  if (suggestion.level === "macro") return "large";
  if (suggestion.level === "meso") return "medium";

  const implLength = suggestion.implementation.length;
  if (implLength < 200) return "trivial";
  if (implLength < 500) return "small";
  return "medium";
}

function assessRisks(suggestion: Suggestion): string[] {
  const risks: string[] = [];

  if (suggestion.level === "macro") {
    risks.push("Architectural change — requires team discussion");
    risks.push("May affect existing conventions");
  }

  if (suggestion.level === "meso") {
    risks.push("Workflow change — test in isolated environment first");
  }

  if (suggestion.confidence < 0.6) {
    risks.push(`Low confidence score (${suggestion.confidence.toFixed(2)}) — review carefully`);
  }

  if (suggestion.tags.includes("security")) {
    risks.push("Security-related change — verify before applying");
  }

  if (suggestion.tags.includes("deployment")) {
    risks.push("Deployment-related — test in staging first");
  }

  return risks;
}

function buildPhase1(suggestions: Suggestion[]): UpdatePhase {
  const microSuggestions = suggestions.filter((s) => s.level === "micro");

  const steps: UpdateStep[] = microSuggestions.map((s, i) => ({
    order: i + 1,
    suggestion: s,
    action: `Append section to CLAUDE.md: "${s.title}"`,
    estimatedEffort: estimateEffort(s),
    risks: assessRisks(s),
    automated: s.confidence >= 0.7 && s.estimatedImpact >= 0.3,
  }));

  return {
    phase: 1,
    name: "Safe CLAUDE.md Additions",
    description:
      "Append new sections to CLAUDE.md based on high-confidence patterns from external repos. Non-destructive — only adds new content.",
    steps,
    totalEstimatedMinutes: steps.reduce((sum, s) => sum + EFFORT_MINUTES[s.estimatedEffort], 0),
  };
}

function buildPhase2(suggestions: Suggestion[]): UpdatePhase {
  const mesoSuggestions = suggestions.filter((s) => s.level === "meso");

  const steps: UpdateStep[] = mesoSuggestions.map((s, i) => ({
    order: i + 1,
    suggestion: s,
    action: `Review and apply workflow improvement: "${s.title}"`,
    estimatedEffort: estimateEffort(s),
    risks: assessRisks(s),
    automated: false, // Meso changes require human review
  }));

  return {
    phase: 2,
    name: "Workflow Improvements",
    description:
      "Improvements to development workflow, CI/CD, testing patterns. Requires human review before applying.",
    steps,
    totalEstimatedMinutes: steps.reduce((sum, s) => sum + EFFORT_MINUTES[s.estimatedEffort], 0),
  };
}

function buildPhase3(suggestions: Suggestion[]): UpdatePhase {
  const macroSuggestions = suggestions.filter((s) => s.level === "macro");

  const steps: UpdateStep[] = macroSuggestions.map((s, i) => ({
    order: i + 1,
    suggestion: s,
    action: `Architecture review: "${s.title}" — Human decision required`,
    estimatedEffort: estimateEffort(s),
    risks: assessRisks(s),
    automated: false,
  }));

  return {
    phase: 3,
    name: "Architecture & Design Decisions",
    description:
      "Architectural suggestions requiring careful human evaluation. Do not apply without team discussion.",
    steps,
    totalEstimatedMinutes: steps.reduce((sum, s) => sum + EFFORT_MINUTES[s.estimatedEffort], 0),
  };
}

function generatePlanId(): string {
  return `plan-${Date.now().toString(36)}`;
}

export function createUpdatePlan(suggestions: Suggestion[]): UpdatePlan {
  logger.info("Creating update plan", { suggestions: suggestions.length });

  const phase1 = buildPhase1(suggestions);
  const phase2 = buildPhase2(suggestions);
  const phase3 = buildPhase3(suggestions);

  const phases = [phase1, phase2, phase3].filter((p) => p.steps.length > 0);

  const totalSteps = phases.reduce((sum, p) => sum + p.steps.length, 0);
  const automatedSteps = phases
    .flatMap((p) => p.steps)
    .filter((s) => s.automated).length;
  const manualSteps = totalSteps - automatedSteps;
  const estimatedTotalMinutes = phases.reduce((sum, p) => sum + p.totalEstimatedMinutes, 0);

  const plan: UpdatePlan = {
    id: generatePlanId(),
    createdAt: new Date().toISOString(),
    phases,
    totalSteps,
    automatedSteps,
    manualSteps,
    estimatedTotalMinutes,
    summary: buildSummary(phases, totalSteps, automatedSteps, estimatedTotalMinutes),
  };

  logger.info("Update plan created", {
    id: plan.id,
    phases: phases.length,
    totalSteps,
    automated: automatedSteps,
    estimatedMinutes: estimatedTotalMinutes,
  });

  return plan;
}

function buildSummary(
  phases: UpdatePhase[],
  totalSteps: number,
  automatedSteps: number,
  estimatedMinutes: number
): string {
  const phaseNames = phases.map((p) => `Phase ${p.phase}: ${p.name}`).join(", ");
  return (
    `${totalSteps} improvements identified across ${phases.length} phases (${phaseNames}). ` +
    `${automatedSteps} can be applied automatically, ${totalSteps - automatedSteps} require manual review. ` +
    `Estimated effort: ${estimatedMinutes < 60 ? `${estimatedMinutes}min` : `${Math.round(estimatedMinutes / 60)}h`}.`
  );
}
