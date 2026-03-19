import { createLogger } from "../audit/logger.js";

const logger = createLogger("patternExtractor");

export type PatternType =
  | "prompt-pattern"
  | "workflow-structure"
  | "tool-usage"
  | "claude-md-section"
  | "mcp-tool-design"
  | "config-pattern"
  | "testing-approach";

export interface ExtractedPattern {
  type: PatternType;
  content: string;
  sourceFile: string;
  confidence: number;
  reusability: number; // 0-1, how transferable this pattern is
  title: string;
  tags: string[];
}

export interface FileContents {
  readme?: string;
  claudeMd?: string;
  packageJson?: string;
  workflowFiles?: Record<string, string>;
  extraFiles?: Record<string, string>;
}

// ------- CLAUDE.md Section Extraction -------

const HEADING_REGEX = /^#{1,3}\s+(.+)$/gm;
const SECTION_MIN_LENGTH = 50;

function extractClaudeMdSections(content: string): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];
  const headings: Array<{ index: number; title: string; level: number }> = [];

  let match: RegExpExecArray | null;
  const headingRe = /^(#{1,3})\s+(.+)$/gm;

  while ((match = headingRe.exec(content)) !== null) {
    headings.push({
      index: match.index,
      title: match[2].trim(),
      level: match[1].length,
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeadingIndex = headings[i + 1]?.index ?? content.length;
    const sectionContent = content.slice(heading.index, nextHeadingIndex).trim();

    if (sectionContent.length < SECTION_MIN_LENGTH) continue;

    // Score reusability based on generic vs project-specific content
    const isProjectSpecific =
      /path|directory|localhost|127\.0\.0|port \d{4}|your project/i.test(sectionContent);
    const reusability = isProjectSpecific ? 0.3 : 0.75;

    patterns.push({
      type: "claude-md-section",
      content: sectionContent,
      sourceFile: "CLAUDE.md",
      confidence: 0.85,
      reusability,
      title: heading.title,
      tags: extractTags(sectionContent),
    });
  }

  return patterns;
}

// ------- MCP Tool Pattern Extraction -------

const MCP_TOOL_PATTERNS = [
  // server.tool(...) or server.setRequestHandler(...)
  /server\.(tool|setRequestHandler)\s*\(\s*["']([^"']+)["']/g,
  // tools: [...] array definitions
  /name:\s*["']([a-z_][a-z0-9_]*)["']\s*,\s*description/g,
];

function extractMcpToolPatterns(content: string, sourceFile: string): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];
  const toolNames = new Set<string>();

  for (const re of MCP_TOOL_PATTERNS) {
    const regex = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      const name = m[2] ?? m[1];
      if (name && !toolNames.has(name)) {
        toolNames.add(name);
      }
    }
  }

  if (toolNames.size > 0) {
    // Extract broader context around tool definitions (first 1500 chars of file)
    const excerpt = content.slice(0, 1500);
    patterns.push({
      type: "mcp-tool-design",
      content: `MCP tools found: ${[...toolNames].join(", ")}\n\nContext:\n${excerpt}`,
      sourceFile,
      confidence: 0.8,
      reusability: 0.9,
      title: `MCP Tool Definitions (${toolNames.size} tools)`,
      tags: ["mcp", "tools", ...Array.from(toolNames).slice(0, 5)],
    });
  }

  return patterns;
}

// ------- Workflow Pattern Extraction -------

function extractWorkflowPatterns(
  workflowFiles: Record<string, string>
): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];

  for (const [filePath, content] of Object.entries(workflowFiles)) {
    if (content.length < 100) continue;

    // Extract job names and steps
    const jobMatches = content.matchAll(/^  (\w[\w-]+):\s*$/gm);
    const jobs: string[] = [];
    for (const m of jobMatches) {
      jobs.push(m[1]);
    }

    if (jobs.length > 0) {
      patterns.push({
        type: "workflow-structure",
        content: content.slice(0, 2000),
        sourceFile: filePath,
        confidence: 0.75,
        reusability: 0.6,
        title: `CI/CD Workflow (jobs: ${jobs.join(", ")})`,
        tags: ["ci", "workflow", "github-actions", ...jobs.slice(0, 3)],
      });
    }
  }

  return patterns;
}

// ------- Config Pattern Extraction -------

function extractConfigPatterns(packageJson: string, extraFiles: Record<string, string>): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];

  try {
    const pkg = JSON.parse(packageJson) as Record<string, unknown>;

    // Extract scripts
    const scripts = pkg["scripts"] as Record<string, string> | undefined;
    if (scripts && Object.keys(scripts).length > 0) {
      patterns.push({
        type: "config-pattern",
        content: `Package scripts:\n${JSON.stringify(scripts, null, 2)}`,
        sourceFile: "package.json",
        confidence: 0.7,
        reusability: 0.7,
        title: "NPM Scripts Configuration",
        tags: ["npm", "scripts", "build", "config"],
      });
    }

    // Extract dependencies for tech signal
    const deps = {
      ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}),
      ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
    };
    const depNames = Object.keys(deps);
    if (depNames.length > 0) {
      patterns.push({
        type: "config-pattern",
        content: `Dependencies: ${depNames.join(", ")}`,
        sourceFile: "package.json",
        confidence: 0.65,
        reusability: 0.5,
        title: "Dependency Stack",
        tags: ["dependencies", "stack"],
      });
    }
  } catch {
    // Not valid JSON, skip
  }

  // eslint/tsconfig patterns
  for (const [filePath, content] of Object.entries(extraFiles)) {
    if ((filePath.includes("tsconfig") || filePath.includes("eslint")) && content.length > 50) {
      patterns.push({
        type: "config-pattern",
        content: content.slice(0, 1000),
        sourceFile: filePath,
        confidence: 0.6,
        reusability: 0.65,
        title: `Config: ${filePath}`,
        tags: ["config", filePath.split("/").pop() ?? filePath],
      });
    }
  }

  return patterns;
}

// ------- Prompt Pattern Extraction -------

const PROMPT_INDICATORS = [
  /you are (a|an) .{5,100}/gi,
  /system prompt/gi,
  /prompt template/gi,
  /```\s*(?:prompt|system|user)\s*\n([\s\S]{100,500}?)```/gi,
];

function extractPromptPatterns(readme: string): ExtractedPattern[] {
  const patterns: ExtractedPattern[] = [];

  for (const re of PROMPT_INDICATORS) {
    const regex = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(readme)) !== null) {
      const excerpt = readme.slice(Math.max(0, m.index - 50), m.index + 400);
      patterns.push({
        type: "prompt-pattern",
        content: excerpt,
        sourceFile: "README.md",
        confidence: 0.65,
        reusability: 0.7,
        title: `Prompt Pattern: ${m[0].slice(0, 60)}`,
        tags: ["prompt", "llm"],
      });
      if (patterns.length >= 3) break; // Don't over-extract
    }
    if (patterns.length >= 3) break;
  }

  return patterns;
}

// ------- Tool Usage Extraction -------

const TOOL_USAGE_PATTERNS = [
  /use\s+(?:the\s+)?(\w[\w-]+)\s+tool/gi,
  /run\s+`([^`]+)`/g,
  /command:\s*`([^`]+)`/g,
];

function extractToolUsage(readme: string): ExtractedPattern[] {
  const tools = new Set<string>();

  for (const re of TOOL_USAGE_PATTERNS) {
    const regex = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(readme)) !== null) {
      if (m[1] && m[1].length < 50) tools.add(m[1]);
    }
  }

  if (tools.size === 0) return [];

  return [
    {
      type: "tool-usage",
      content: `Tools mentioned: ${[...tools].join(", ")}`,
      sourceFile: "README.md",
      confidence: 0.5,
      reusability: 0.6,
      title: `Tool Usage Patterns (${tools.size} tools)`,
      tags: ["tools", ...Array.from(tools).slice(0, 5)],
    },
  ];
}

// ------- Helpers -------

function extractTags(content: string): string[] {
  const lower = content.toLowerCase();
  const tagCandidates = [
    "typescript",
    "python",
    "rust",
    "nodejs",
    "fastapi",
    "testing",
    "security",
    "workflow",
    "mcp",
    "claude",
    "automation",
    "ci/cd",
    "docker",
    "api",
    "git",
    "database",
    "performance",
    "architecture",
  ];
  return tagCandidates.filter((t) => lower.includes(t));
}

// ------- Main Entry Point -------

export function extractPatterns(files: FileContents): ExtractedPattern[] {
  const all: ExtractedPattern[] = [];

  if (files.claudeMd && files.claudeMd.length > 0) {
    all.push(...extractClaudeMdSections(files.claudeMd));
  }

  if (files.readme && files.readme.length > 0) {
    all.push(...extractPromptPatterns(files.readme));
    all.push(...extractToolUsage(files.readme));
  }

  if (files.packageJson) {
    all.push(
      ...extractConfigPatterns(files.packageJson, files.extraFiles ?? {})
    );
  }

  if (files.workflowFiles && Object.keys(files.workflowFiles).length > 0) {
    all.push(...extractWorkflowPatterns(files.workflowFiles));
  }

  // Scan extra files for MCP tool patterns
  for (const [filePath, content] of Object.entries(files.extraFiles ?? {})) {
    if (filePath.endsWith(".ts") || filePath.endsWith(".js")) {
      all.push(...extractMcpToolPatterns(content, filePath));
    }
  }

  logger.debug("Patterns extracted", { count: all.length });
  return all;
}
