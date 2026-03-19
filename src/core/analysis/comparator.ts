import type { ExtractedPattern } from "./patternExtractor.js";
import type { LocalDNA } from "./dnaProfiler.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("comparator");

export interface Gap {
  patternType: string;
  title: string;
  description: string;
  sourcePattern: ExtractedPattern;
  severity: "high" | "medium" | "low";
}

export interface Enhancement {
  existingSection: string;
  title: string;
  description: string;
  sourcePattern: ExtractedPattern;
  suggestedAddition: string;
}

export interface Conflict {
  localSection: string;
  externalPattern: ExtractedPattern;
  description: string;
  resolution: string;
}

export interface ComparisonResult {
  gaps: Gap[];
  enhancements: Enhancement[];
  conflicts: Conflict[];
  overallFitScore: number; // 0-1, how well external patterns match local DNA
  sourceRepo: string;
}

// Sections that are commonly missing from CLAUDE.md files
const VALUABLE_SECTIONS = [
  { keyword: "testing", title: "Testing Requirements", severity: "high" as const },
  { keyword: "security", title: "Security Guidelines", severity: "high" as const },
  { keyword: "deployment", title: "Deployment Standards", severity: "medium" as const },
  { keyword: "error handling", title: "Error Handling", severity: "medium" as const },
  { keyword: "architecture", title: "Architecture Overview", severity: "medium" as const },
  { keyword: "workflow", title: "Development Workflow", severity: "medium" as const },
  { keyword: "git", title: "Git Workflow", severity: "low" as const },
  { keyword: "performance", title: "Performance Guidelines", severity: "low" as const },
  { keyword: "coding style", title: "Coding Style", severity: "low" as const },
  { keyword: "debugging", title: "Debugging Guidelines", severity: "low" as const },
];

function normalizeSection(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

function sectionExists(sections: string[], keyword: string): boolean {
  const norm = normalizeSection(keyword);
  return sections.some((s) => normalizeSection(s).includes(norm));
}

function findGaps(patterns: ExtractedPattern[], dna: LocalDNA): Gap[] {
  const gaps: Gap[] = [];
  const localSectionsNorm = dna.claudeMdSections.map(normalizeSection);

  for (const pattern of patterns) {
    if (pattern.type !== "claude-md-section") continue;
    if (pattern.reusability < 0.5) continue;
    if (pattern.confidence < 0.6) continue;

    const normTitle = normalizeSection(pattern.title);

    // Check if this section exists locally
    const exists = localSectionsNorm.some((s) => s.includes(normTitle) || normTitle.includes(s));

    if (!exists) {
      // Check if it matches a valuable section
      const valuable = VALUABLE_SECTIONS.find((v) =>
        normTitle.includes(normalizeSection(v.keyword)) ||
        normalizeSection(v.keyword).includes(normTitle)
      );

      gaps.push({
        patternType: pattern.type,
        title: pattern.title,
        description: `Section "${pattern.title}" found in external repo but missing locally`,
        sourcePattern: pattern,
        severity: valuable?.severity ?? "low",
      });
    }
  }

  // Also check for missing high-value sections not covered by patterns
  for (const valuable of VALUABLE_SECTIONS) {
    if (!sectionExists(dna.claudeMdSections, valuable.keyword)) {
      const alreadyAdded = gaps.some((g) =>
        normalizeSection(g.title).includes(normalizeSection(valuable.keyword))
      );

      if (!alreadyAdded && valuable.severity === "high") {
        gaps.push({
          patternType: "claude-md-section",
          title: valuable.title,
          description: `High-value section "${valuable.title}" is missing from CLAUDE.md`,
          sourcePattern: {
            type: "claude-md-section",
            content: `## ${valuable.title}\n\n_To be filled based on project requirements_`,
            sourceFile: "CLAUDE.md",
            confidence: 0.5,
            reusability: 0.8,
            title: valuable.title,
            tags: [valuable.keyword],
          },
          severity: valuable.severity,
        });
      }
    }
  }

  return gaps;
}

function findEnhancements(patterns: ExtractedPattern[], dna: LocalDNA): Enhancement[] {
  const enhancements: Enhancement[] = [];

  for (const pattern of patterns) {
    if (pattern.type !== "claude-md-section") continue;
    if (pattern.reusability < 0.6) continue;

    const normTitle = normalizeSection(pattern.title);

    // Find matching local section
    const matchingLocal = dna.claudeMdSections.find((s) => {
      const norm = normalizeSection(s);
      return norm.includes(normTitle) || normTitle.includes(norm);
    });

    if (!matchingLocal) continue;

    // Pattern exists locally but external version has additional content
    const localLength = dna.claudeMdWordCount / Math.max(1, dna.claudeMdSections.length);
    const externalWordCount = pattern.content.split(/\s+/).length;

    // External section is substantially longer → potential enhancement
    if (externalWordCount > localLength * 1.5 && externalWordCount > 50) {
      enhancements.push({
        existingSection: matchingLocal,
        title: `Enhance "${matchingLocal}" section`,
        description: `External repo has more detailed "${pattern.title}" section (${externalWordCount} words vs ~${Math.round(localLength)} avg local)`,
        sourcePattern: pattern,
        suggestedAddition: pattern.content.slice(0, 800),
      });
    }
  }

  // Check for MCP tool design enhancements
  const mcpPatterns = patterns.filter((p) => p.type === "mcp-tool-design");
  if (mcpPatterns.length > 0 && dna.mcpServers.length > 0) {
    enhancements.push({
      existingSection: "MCP Configuration",
      title: "MCP Tool Design Patterns",
      description: "External repos show useful MCP tool design patterns",
      sourcePattern: mcpPatterns[0],
      suggestedAddition: mcpPatterns.map((p) => p.content.slice(0, 300)).join("\n\n"),
    });
  }

  return enhancements;
}

function findConflicts(patterns: ExtractedPattern[], dna: LocalDNA): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const pattern of patterns) {
    if (pattern.type !== "claude-md-section") continue;

    // Detect style conflicts
    const content = pattern.content.toLowerCase();

    // Mutable vs immutable conflict
    if (content.includes("mutate") && !content.includes("immutab")) {
      const hasImmutabilityRule = dna.claudeMdSections.some((s) =>
        s.toLowerCase().includes("immutab")
      );
      if (hasImmutabilityRule) {
        conflicts.push({
          localSection: "Coding Style",
          externalPattern: pattern,
          description: "External pattern promotes mutation, but local rules prefer immutability",
          resolution: "Skip this pattern — conflicts with immutability principle",
        });
      }
    }

    // Language conflicts
    const externalLangs = ["python", "ruby", "java"].filter((l) => content.includes(l));
    const localLangs = dna.languages.map((l) => l.toLowerCase());

    for (const lang of externalLangs) {
      if (localLangs.length > 0 && !localLangs.includes(lang)) {
        conflicts.push({
          localSection: "Tech Stack",
          externalPattern: pattern,
          description: `External pattern uses ${lang} but local project uses ${dna.languages.join(", ")}`,
          resolution: "Adapt pattern to match local language stack",
        });
        break; // One conflict per pattern is enough
      }
    }
  }

  return conflicts;
}

function calculateFitScore(
  gaps: Gap[],
  enhancements: Enhancement[],
  conflicts: Conflict[],
  dna: LocalDNA
): number {
  let score = 0.5; // Base

  // Gaps = opportunities (positive signal)
  const highGaps = gaps.filter((g) => g.severity === "high").length;
  const medGaps = gaps.filter((g) => g.severity === "medium").length;
  score += highGaps * 0.05 + medGaps * 0.025;

  // Enhancements are good fits
  score += enhancements.length * 0.05;

  // Conflicts reduce fit
  score -= conflicts.length * 0.1;

  // DNA compatibility bonus
  if (dna.hasClaudeMd) score += 0.1;
  if (dna.hasDotClaude) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

export function compareWithLocal(
  patterns: ExtractedPattern[],
  dna: LocalDNA,
  sourceRepo: string
): ComparisonResult {
  logger.debug("Comparing patterns with local DNA", {
    patterns: patterns.length,
    sourceRepo,
    localSections: dna.claudeMdSections.length,
  });

  const gaps = findGaps(patterns, dna);
  const enhancements = findEnhancements(patterns, dna);
  const conflicts = findConflicts(patterns, dna);
  const overallFitScore = calculateFitScore(gaps, enhancements, conflicts, dna);

  logger.info("Comparison complete", {
    sourceRepo,
    gaps: gaps.length,
    enhancements: enhancements.length,
    conflicts: conflicts.length,
    fitScore: overallFitScore,
  });

  return { gaps, enhancements, conflicts, overallFitScore, sourceRepo };
}

export function mergeComparisons(results: ComparisonResult[]): {
  allGaps: Gap[];
  allEnhancements: Enhancement[];
  allConflicts: Conflict[];
  avgFitScore: number;
} {
  const allGaps: Gap[] = [];
  const allEnhancements: Enhancement[] = [];
  const allConflicts: Conflict[] = [];
  const seenGapTitles = new Set<string>();
  const seenEnhancementTitles = new Set<string>();

  for (const result of results) {
    for (const gap of result.gaps) {
      if (!seenGapTitles.has(gap.title)) {
        allGaps.push(gap);
        seenGapTitles.add(gap.title);
      }
    }

    for (const enhancement of result.enhancements) {
      if (!seenEnhancementTitles.has(enhancement.title)) {
        allEnhancements.push(enhancement);
        seenEnhancementTitles.add(enhancement.title);
      }
    }

    allConflicts.push(...result.conflicts);
  }

  const avgFitScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.overallFitScore, 0) / results.length
      : 0;

  return { allGaps, allEnhancements, allConflicts, avgFitScore };
}
