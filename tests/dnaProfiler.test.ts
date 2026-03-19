import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Set test paths before importing config-dependent modules
const TEST_REPO_PATH = join(tmpdir(), `dna-test-${Date.now()}`);
const TEST_DATA_DIR = join(tmpdir(), `dna-data-${Date.now()}`);
process.env["LOCAL_REPO_PATH"] = TEST_REPO_PATH;
process.env["CLAUDE_INTEL_DATA_DIR"] = TEST_DATA_DIR;

import { profileLocalRepo } from "../src/core/analysis/dnaProfiler.js";

function writeFile(repoPath: string, relPath: string, content: string): void {
  const fullPath = join(repoPath, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("dnaProfiler", () => {
  beforeEach(() => {
    mkdirSync(TEST_REPO_PATH, { recursive: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_REPO_PATH, { recursive: true, force: true });
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("package.json detection", () => {
    it("detects TypeScript project from package.json", () => {
      writeFile(
        TEST_REPO_PATH,
        "package.json",
        JSON.stringify({
          name: "my-ts-project",
          devDependencies: {
            typescript: "^5.0.0",
          },
        })
      );
      writeFile(TEST_REPO_PATH, "src/index.ts", "export const foo = 1;");

      const dna = profileLocalRepo(TEST_REPO_PATH);

      expect(dna.packageName).toBe("my-ts-project");
      expect(dna.languages).toContain("TypeScript");
    });

    it("detects MCP SDK usage", () => {
      writeFile(
        TEST_REPO_PATH,
        "package.json",
        JSON.stringify({
          name: "my-mcp-server",
          dependencies: {
            "@modelcontextprotocol/sdk": "^1.0.0",
            zod: "^3.23.8",
          },
        })
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);

      expect(dna.frameworks).toContain("MCP SDK");
      expect(dna.frameworks).toContain("Zod");
    });

    it("detects test framework (Vitest)", () => {
      writeFile(
        TEST_REPO_PATH,
        "package.json",
        JSON.stringify({
          name: "test-project",
          devDependencies: {
            vitest: "^2.0.0",
          },
        })
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.testFramework).toContain("Vitest");
    });

    it("detects CLI architecture via bin field", () => {
      writeFile(
        TEST_REPO_PATH,
        "package.json",
        JSON.stringify({
          name: "my-cli",
          bin: { "my-cli": "dist/index.js" },
        })
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.architectureStyle).toBe("cli");
    });

    it("detects monorepo via pnpm workspaces", () => {
      writeFile(TEST_REPO_PATH, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
      writeFile(
        TEST_REPO_PATH,
        "package.json",
        JSON.stringify({ name: "monorepo-root" })
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.architectureStyle).toBe("monorepo");
    });
  });

  describe("CLAUDE.md detection", () => {
    it("detects CLAUDE.md presence", () => {
      writeFile(
        TEST_REPO_PATH,
        "CLAUDE.md",
        "# My Project\n\n## Testing\n\nAlways use TDD.\n"
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);

      expect(dna.hasClaudeMd).toBe(true);
      expect(dna.claudeMdWordCount).toBeGreaterThan(5);
    });

    it("extracts section headings from CLAUDE.md", () => {
      writeFile(
        TEST_REPO_PATH,
        "CLAUDE.md",
        "# My Project\n\n## Testing\n\nUse TDD.\n\n## Security\n\nNo secrets in code.\n"
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);

      expect(dna.claudeMdSections).toContain("Testing");
      expect(dna.claudeMdSections).toContain("Security");
    });

    it("detects TDD workflow style from CLAUDE.md", () => {
      writeFile(
        TEST_REPO_PATH,
        "CLAUDE.md",
        "# Rules\n\n## TDD Approach\n\nAlways write failing test first. Red-Green-Refactor.\n"
      );

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.workflowStyle).toBe("tdd");
    });

    it("reports hasClaudeMd=false when file absent", () => {
      // Don't create CLAUDE.md
      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.hasClaudeMd).toBe(false);
      expect(dna.claudeMdSections).toHaveLength(0);
    });
  });

  describe("CI detection", () => {
    it("detects GitHub Actions", () => {
      mkdirSync(join(TEST_REPO_PATH, ".github", "workflows"), { recursive: true });
      writeFile(TEST_REPO_PATH, ".github/workflows/ci.yml", "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n");

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.ciSystem).toContain("GitHub Actions");
    });
  });

  describe("test directory detection", () => {
    it("detects tests/ directory", () => {
      mkdirSync(join(TEST_REPO_PATH, "tests"), { recursive: true });
      writeFile(TEST_REPO_PATH, "tests/example.test.ts", "it('test', () => {})");

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.hasTests).toBe(true);
    });

    it("reports hasTests=false when no test dirs", () => {
      // Don't create any test directories
      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.hasTests).toBe(false);
    });
  });

  describe("coding conventions detection", () => {
    it("detects ESLint configuration", () => {
      writeFile(TEST_REPO_PATH, ".eslintrc.json", '{"extends": ["eslint:recommended"]}');

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.codingConventions).toContain("ESLint");
    });

    it("detects Prettier configuration", () => {
      writeFile(TEST_REPO_PATH, ".prettierrc", '{"semi": true, "singleQuote": false}');

      const dna = profileLocalRepo(TEST_REPO_PATH);
      expect(dna.codingConventions).toContain("Prettier");
    });
  });
});
