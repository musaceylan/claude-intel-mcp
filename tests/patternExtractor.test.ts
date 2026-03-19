import { describe, it, expect } from "vitest";
import { extractPatterns } from "../src/core/analysis/patternExtractor.js";
import type { FileContents } from "../src/core/analysis/patternExtractor.js";

const SAMPLE_CLAUDE_MD = `# My Project — Claude Code Configuration

## Core Rules

Always write tests first. No production code without a failing test.

## Testing Requirements

All code must have 80% test coverage minimum.
Use Vitest for unit tests. Run with \`npm test\`.

## Security Guidelines

Never commit secrets. Use environment variables.
Rate limit all endpoints. Validate all inputs.

## Deployment Standards

Use PM2 for Node apps. Use systemd for Python services.
Always backup before major changes.

## Git Workflow

Use conventional commits: feat, fix, refactor, docs, test, chore.
Never force push to main.
`;

const SAMPLE_README = `# My MCP Server

Run \`npm install\` to get started.

Use the scan_github_trends tool to find relevant repos.
Use the compare_with_local_repo tool for analysis.

## Prompts

You are a developer intelligence expert. Analyze the following repositories...

\`\`\`prompt
You are a senior developer. Review this code carefully.
Consider security, performance, and maintainability.
\`\`\`
`;

const SAMPLE_PACKAGE_JSON = JSON.stringify({
  name: "my-project",
  scripts: {
    build: "tsc",
    test: "vitest run",
    dev: "tsx watch src/index.ts",
    lint: "eslint src",
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "^1.0.0",
    zod: "^3.23.8",
    "better-sqlite3": "^9.4.3",
  },
  devDependencies: {
    vitest: "^2.0.0",
    typescript: "^5.5.0",
  },
});

describe("patternExtractor", () => {
  describe("CLAUDE.md section extraction", () => {
    it("extracts sections from CLAUDE.md", () => {
      const patterns = extractPatterns({ claudeMd: SAMPLE_CLAUDE_MD });

      const sectionPatterns = patterns.filter((p) => p.type === "claude-md-section");
      expect(sectionPatterns.length).toBeGreaterThan(0);

      const titles = sectionPatterns.map((p) => p.title);
      expect(titles).toContain("Testing Requirements");
      expect(titles).toContain("Security Guidelines");
    });

    it("assigns high confidence to CLAUDE.md sections", () => {
      const patterns = extractPatterns({ claudeMd: SAMPLE_CLAUDE_MD });
      const sections = patterns.filter((p) => p.type === "claude-md-section");

      for (const section of sections) {
        expect(section.confidence).toBeGreaterThan(0.7);
      }
    });

    it("extracts content for each section", () => {
      const patterns = extractPatterns({ claudeMd: SAMPLE_CLAUDE_MD });
      const sections = patterns.filter((p) => p.type === "claude-md-section");

      for (const section of sections) {
        expect(section.content.length).toBeGreaterThan(10);
      }
    });

    it("returns empty array for empty CLAUDE.md", () => {
      const patterns = extractPatterns({ claudeMd: "" });
      expect(patterns).toHaveLength(0);
    });
  });

  describe("prompt pattern extraction", () => {
    it("extracts prompt patterns from README", () => {
      const patterns = extractPatterns({ readme: SAMPLE_README });
      const promptPatterns = patterns.filter((p) => p.type === "prompt-pattern");
      expect(promptPatterns.length).toBeGreaterThan(0);
    });
  });

  describe("tool usage extraction", () => {
    it("extracts tool usage patterns from README", () => {
      const patterns = extractPatterns({ readme: SAMPLE_README });
      const toolPatterns = patterns.filter((p) => p.type === "tool-usage");
      expect(toolPatterns.length).toBeGreaterThan(0);

      const toolContent = toolPatterns.map((p) => p.content).join(" ");
      expect(toolContent).toMatch(/tool/i);
    });
  });

  describe("config pattern extraction", () => {
    it("extracts NPM scripts from package.json", () => {
      const patterns = extractPatterns({ packageJson: SAMPLE_PACKAGE_JSON });
      const configPatterns = patterns.filter((p) => p.type === "config-pattern");

      const scriptsPattern = configPatterns.find((p) => p.title.includes("Scripts"));
      expect(scriptsPattern).toBeDefined();
      expect(scriptsPattern?.content).toContain("build");
      expect(scriptsPattern?.content).toContain("test");
    });

    it("extracts dependency stack from package.json", () => {
      const patterns = extractPatterns({ packageJson: SAMPLE_PACKAGE_JSON });
      const configPatterns = patterns.filter((p) => p.type === "config-pattern");

      const depsPattern = configPatterns.find((p) => p.title.includes("Dependency"));
      expect(depsPattern).toBeDefined();
    });
  });

  describe("MCP tool pattern extraction", () => {
    const sampleMcpFile = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "scan_repos", description: "Scan repositories" },
    { name: "compare_files", description: "Compare files" },
  ],
}));

server.tool("generate_report", async (input) => {
  // ...
});
`;

    it("extracts MCP tool names from source files", () => {
      const patterns = extractPatterns({
        extraFiles: { "src/server.ts": sampleMcpFile },
      });

      const mcpPatterns = patterns.filter((p) => p.type === "mcp-tool-design");
      expect(mcpPatterns.length).toBeGreaterThan(0);
    });
  });

  describe("combined extraction", () => {
    it("extracts patterns from all file types simultaneously", () => {
      const files: FileContents = {
        claudeMd: SAMPLE_CLAUDE_MD,
        readme: SAMPLE_README,
        packageJson: SAMPLE_PACKAGE_JSON,
      };

      const patterns = extractPatterns(files);

      const types = new Set(patterns.map((p) => p.type));
      expect(types.has("claude-md-section")).toBe(true);
      expect(types.has("config-pattern")).toBe(true);
    });
  });
});
