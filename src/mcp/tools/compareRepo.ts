import { z } from "zod";
import { GithubClient } from "../../core/github/githubClient.js";
import { classifyRepo } from "../../core/analysis/repoClassifier.js";
import { extractPatterns } from "../../core/analysis/patternExtractor.js";
import { profileLocalRepo } from "../../core/analysis/dnaProfiler.js";
import { compareWithLocal } from "../../core/analysis/comparator.js";
import { storePattern, markProcessed } from "../../core/analysis/patternMemory.js";
import { recordEvent } from "../../core/audit/learningLog.js";
import { createLogger } from "../../core/audit/logger.js";
import pLimit from "p-limit";

const logger = createLogger("tool:compareRepo");

export const CompareRepoInputSchema = z.object({
  repoFullName: z
    .string()
    .describe("Full repository name in format 'owner/repo'"),
  localPath: z
    .string()
    .optional()
    .describe("Path to the local repository to compare against (defaults to cwd)"),
});

export type CompareRepoInput = z.infer<typeof CompareRepoInputSchema>;

export interface CompareRepoOutput {
  repoFullName: string;
  category: string;
  patternsExtracted: number;
  gaps: Array<{
    title: string;
    description: string;
    severity: string;
    patternType: string;
  }>;
  enhancements: Array<{
    existingSection: string;
    title: string;
    description: string;
  }>;
  conflicts: Array<{
    localSection: string;
    description: string;
    resolution: string;
  }>;
  overallFitScore: number;
  localDna: {
    languages: string[];
    frameworks: string[];
    hasClaudeMd: boolean;
    claudeMdSections: string[];
    workflowStyle: string;
  };
}

export async function compareRepo(input: CompareRepoInput): Promise<CompareRepoOutput> {
  logger.info("Comparing repo with local", { repo: input.repoFullName });

  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: "${input.repoFullName}". Expected "owner/repo"`);
  }

  const client = new GithubClient();
  const limit = pLimit(3);

  // Fetch repo data in parallel
  const [repoData, readme, claudeMd, packageJson] = await Promise.all([
    limit(() => client.getRepo(owner, repo)),
    limit(() => client.getReadme(owner, repo)),
    limit(() => client.getFileContents(owner, repo, "CLAUDE.md")),
    limit(() => client.getFileContents(owner, repo, "package.json")),
  ]);

  // Classify the repo
  const classified = classifyRepo(repoData, readme);

  // Extract patterns
  const patterns = extractPatterns({
    readme,
    claudeMd,
    packageJson,
    extraFiles: {},
  });

  // Store patterns in memory
  for (const pattern of patterns) {
    storePattern(pattern, input.repoFullName);
  }
  markProcessed(input.repoFullName);

  // Profile local repo
  const dna = profileLocalRepo(input.localPath);

  // Compare
  const comparison = compareWithLocal(patterns, dna, input.repoFullName);

  // Record event
  recordEvent({
    timestamp: new Date().toISOString(),
    event_type: "compare",
    repo_full_name: input.repoFullName,
    patterns_found: patterns.length,
    score: comparison.overallFitScore,
    applied: false,
    notes: `${comparison.gaps.length} gaps, ${comparison.enhancements.length} enhancements, ${comparison.conflicts.length} conflicts`,
  });

  return {
    repoFullName: input.repoFullName,
    category: classified.category,
    patternsExtracted: patterns.length,
    gaps: comparison.gaps.map((g) => ({
      title: g.title,
      description: g.description,
      severity: g.severity,
      patternType: g.patternType,
    })),
    enhancements: comparison.enhancements.map((e) => ({
      existingSection: e.existingSection,
      title: e.title,
      description: e.description,
    })),
    conflicts: comparison.conflicts.map((c) => ({
      localSection: c.localSection,
      description: c.description,
      resolution: c.resolution,
    })),
    overallFitScore: comparison.overallFitScore,
    localDna: {
      languages: dna.languages,
      frameworks: dna.frameworks,
      hasClaudeMd: dna.hasClaudeMd,
      claudeMdSections: dna.claudeMdSections,
      workflowStyle: dna.workflowStyle,
    },
  };
}
