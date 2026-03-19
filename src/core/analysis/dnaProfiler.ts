import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { getConfig } from "../../config/config.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("dnaProfiler");

export type WorkflowStyle = "tdd" | "plan-driven" | "iterative" | "unknown";
export type ArchitectureStyle =
  | "monolith"
  | "monorepo"
  | "microservices"
  | "library"
  | "cli"
  | "unknown";

export interface LocalDNA {
  stack: string[];
  languages: string[];
  frameworks: string[];
  testFramework: string[];
  ciSystem: string[];
  hasClaudeMd: boolean;
  claudeMdSections: string[];
  claudeMdWordCount: number;
  workflowStyle: WorkflowStyle;
  architectureStyle: ArchitectureStyle;
  codingConventions: string[];
  hasTests: boolean;
  hasDotClaude: boolean;
  claudeAgents: string[];
  claudeCommands: string[];
  mcpServers: string[];
  packageName: string | null;
  localPath: string;
}

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parsePackageJson(pkgPath: string): Record<string, unknown> {
  const content = safeRead(pkgPath);
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function detectLanguages(repoPath: string): string[] {
  const langs = new Set<string>();

  const extensionMap: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".rb": "Ruby",
    ".swift": "Swift",
    ".kt": "Kotlin",
    ".java": "Java",
    ".cs": "C#",
    ".php": "PHP",
  };

  function scanDir(dir: string, depth = 0): void {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else {
            const ext = extname(entry).toLowerCase();
            const lang = extensionMap[ext];
            if (lang) langs.add(lang);
          }
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // skip unreadable directories
    }
  }

  scanDir(repoPath);
  return Array.from(langs);
}

function detectFrameworks(pkg: Record<string, unknown>, languages: string[]): string[] {
  const frameworks: string[] = [];
  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}),
    ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
  };
  const depNames = Object.keys(deps).map((d) => d.toLowerCase());

  const frameworkMap: Array<{ deps: string[]; name: string }> = [
    { deps: ["next", "nextjs"], name: "Next.js" },
    { deps: ["react", "react-dom"], name: "React" },
    { deps: ["vue", "@vue/core"], name: "Vue" },
    { deps: ["@sveltejs/kit", "svelte"], name: "Svelte" },
    { deps: ["express"], name: "Express" },
    { deps: ["fastify"], name: "Fastify" },
    { deps: ["@nestjs/core"], name: "NestJS" },
    { deps: ["hono"], name: "Hono" },
    { deps: ["prisma", "@prisma/client"], name: "Prisma" },
    { deps: ["drizzle-orm"], name: "Drizzle" },
    { deps: ["better-sqlite3"], name: "SQLite" },
    { deps: ["@modelcontextprotocol/sdk"], name: "MCP SDK" },
    { deps: ["zod"], name: "Zod" },
  ];

  for (const { deps: frameworkDeps, name } of frameworkMap) {
    if (frameworkDeps.some((d) => depNames.includes(d))) {
      frameworks.push(name);
    }
  }

  // Python frameworks
  if (languages.includes("Python")) {
    const requirementsPath = join(getConfig().localRepoPath, "requirements.txt");
    const requirements = safeRead(requirementsPath).toLowerCase();
    if (requirements.includes("fastapi")) frameworks.push("FastAPI");
    if (requirements.includes("flask")) frameworks.push("Flask");
    if (requirements.includes("django")) frameworks.push("Django");
  }

  return frameworks;
}

function detectTestFramework(pkg: Record<string, unknown>, repoPath: string): string[] {
  const frameworks: string[] = [];
  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}),
    ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
  };
  const depNames = Object.keys(deps).map((d) => d.toLowerCase());

  if (depNames.includes("vitest")) frameworks.push("Vitest");
  if (depNames.includes("jest")) frameworks.push("Jest");
  if (depNames.includes("mocha")) frameworks.push("Mocha");
  if (depNames.includes("@playwright/test")) frameworks.push("Playwright");
  if (depNames.includes("cypress")) frameworks.push("Cypress");

  // Check for pytest
  if (existsSync(join(repoPath, "pytest.ini")) || existsSync(join(repoPath, "pyproject.toml"))) {
    const pyproject = safeRead(join(repoPath, "pyproject.toml"));
    if (pyproject.includes("pytest")) frameworks.push("pytest");
  }

  return frameworks;
}

function detectCiSystem(repoPath: string): string[] {
  const systems: string[] = [];
  const githubWorkflowsDir = join(repoPath, ".github", "workflows");

  if (existsSync(githubWorkflowsDir)) systems.push("GitHub Actions");
  if (existsSync(join(repoPath, ".circleci"))) systems.push("CircleCI");
  if (existsSync(join(repoPath, "Jenkinsfile"))) systems.push("Jenkins");
  if (existsSync(join(repoPath, ".travis.yml"))) systems.push("Travis CI");
  if (existsSync(join(repoPath, "bitbucket-pipelines.yml"))) systems.push("Bitbucket Pipelines");

  return systems;
}

function extractClaudeMdSections(content: string): string[] {
  const sections: string[] = [];
  const headingRe = /^#{1,3}\s+(.+)$/gm;
  let m: RegExpExecArray | null;

  while ((m = headingRe.exec(content)) !== null) {
    sections.push(m[1].trim());
  }

  return sections;
}

function detectWorkflowStyle(claudeMd: string, pkg: Record<string, unknown>): WorkflowStyle {
  const lower = claudeMd.toLowerCase();

  if (
    lower.includes("test-driven") ||
    lower.includes("tdd") ||
    lower.includes("write test first") ||
    lower.includes("red-green")
  ) {
    return "tdd";
  }

  if (
    lower.includes("plan first") ||
    lower.includes("planning") ||
    lower.includes("roadmap")
  ) {
    return "plan-driven";
  }

  const scripts = pkg["scripts"] as Record<string, string> | undefined ?? {};
  if (Object.keys(scripts).some((s) => s.includes("test"))) {
    return "iterative";
  }

  return "unknown";
}

function detectArchitectureStyle(repoPath: string, pkg: Record<string, unknown>): ArchitectureStyle {
  if (existsSync(join(repoPath, "pnpm-workspace.yaml")) || existsSync(join(repoPath, "lerna.json"))) {
    return "monorepo";
  }

  const workspaces = pkg["workspaces"];
  if (workspaces) return "monorepo";

  const bin = pkg["bin"];
  if (bin) return "cli";

  // Library pattern: has main/exports but no server code
  const main = pkg["main"] as string | undefined;
  const hasLib = main?.includes("lib") || main?.includes("dist");
  if (hasLib && !existsSync(join(repoPath, "src", "server"))) return "library";

  return "monolith";
}

function detectCodingConventions(
  pkg: Record<string, unknown>,
  repoPath: string
): string[] {
  const conventions: string[] = [];
  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}),
    ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
  };
  const depNames = Object.keys(deps).map((d) => d.toLowerCase());

  if (depNames.includes("eslint") || existsSync(join(repoPath, ".eslintrc.json"))) {
    conventions.push("ESLint");
  }
  if (depNames.includes("prettier") || existsSync(join(repoPath, ".prettierrc"))) {
    conventions.push("Prettier");
  }
  if (existsSync(join(repoPath, ".editorconfig"))) conventions.push("EditorConfig");
  if (existsSync(join(repoPath, "biome.json"))) conventions.push("Biome");

  return conventions;
}

function scanDotClaude(repoPath: string): {
  exists: boolean;
  agents: string[];
  commands: string[];
  mcpServers: string[];
} {
  const dotClaudePath = join(repoPath, ".claude");
  if (!existsSync(dotClaudePath)) {
    return { exists: false, agents: [], commands: [], mcpServers: [] };
  }

  const agents: string[] = [];
  const commands: string[] = [];

  try {
    const items = readdirSync(dotClaudePath);
    for (const item of items) {
      if (item.endsWith(".json") && item.includes("agent")) agents.push(item.replace(".json", ""));
      if (item.endsWith(".md")) commands.push(item.replace(".md", ""));
    }
  } catch {
    // skip
  }

  // Parse settings.json for MCP servers
  const settingsPath = join(dotClaudePath, "settings.json");
  let mcpServers: string[] = [];

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(safeRead(settingsPath)) as Record<string, unknown>;
      const mcpConfig = settings["mcpServers"] as Record<string, unknown> | undefined;
      if (mcpConfig) mcpServers = Object.keys(mcpConfig);
    } catch {
      // skip
    }
  }

  return { exists: true, agents, commands, mcpServers };
}

function hasTestFiles(repoPath: string): boolean {
  const testDirs = ["tests", "test", "__tests__", "spec"];
  return testDirs.some((dir) => existsSync(join(repoPath, dir)));
}

export function profileLocalRepo(repoPath?: string): LocalDNA {
  const targetPath = repoPath ?? getConfig().localRepoPath;
  logger.info("Profiling local repo", { path: targetPath });

  const pkgPath = join(targetPath, "package.json");
  const pkg = parsePackageJson(pkgPath);

  const claudeMdPath = join(targetPath, "CLAUDE.md");
  const claudeMd = safeRead(claudeMdPath);
  const hasClaudeMd = claudeMd.length > 0;

  const languages = detectLanguages(targetPath);
  const frameworks = detectFrameworks(pkg, languages);
  const testFramework = detectTestFramework(pkg, targetPath);
  const ciSystem = detectCiSystem(targetPath);
  const workflowStyle = detectWorkflowStyle(claudeMd, pkg);
  const architectureStyle = detectArchitectureStyle(targetPath, pkg);
  const codingConventions = detectCodingConventions(pkg, targetPath);
  const claudeMdSections = hasClaudeMd ? extractClaudeMdSections(claudeMd) : [];
  const dotClaude = scanDotClaude(targetPath);

  const stack: string[] = [
    ...languages,
    ...frameworks,
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  const dna: LocalDNA = {
    stack,
    languages,
    frameworks,
    testFramework,
    ciSystem,
    hasClaudeMd,
    claudeMdSections,
    claudeMdWordCount: claudeMd.split(/\s+/).length,
    workflowStyle,
    architectureStyle,
    codingConventions,
    hasTests: hasTestFiles(targetPath),
    hasDotClaude: dotClaude.exists,
    claudeAgents: dotClaude.agents,
    claudeCommands: dotClaude.commands,
    mcpServers: dotClaude.mcpServers,
    packageName: (pkg["name"] as string | undefined) ?? null,
    localPath: targetPath,
  };

  logger.debug("DNA profile complete", {
    languages: dna.languages,
    frameworks: dna.frameworks,
    hasClaudeMd: dna.hasClaudeMd,
    sections: dna.claudeMdSections.length,
  });

  return dna;
}
