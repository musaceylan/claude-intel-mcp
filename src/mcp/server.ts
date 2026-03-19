import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { scanTrends, ScanTrendsInputSchema } from "./tools/scanTrends.js";
import { rankRepos, RankReposInputSchema } from "./tools/rankRepos.js";
import { compareRepo, CompareRepoInputSchema } from "./tools/compareRepo.js";
import { generatePatch, GeneratePatchInputSchema } from "./tools/generatePatch.js";
import { applyUpdates, ApplyUpdatesInputSchema } from "./tools/applyUpdates.js";

import {
  getLatestTrendsContent,
  getRankedReposContent,
  getLearningHistoryContent,
  updateTrendsCache,
} from "./resources/trendsResource.js";
import {
  getDnaProfileContent,
  getGapAnalysisContent,
  getCurrentClaudeMdContent,
  getProposedClaudeMdContent,
  getLearningLogContent,
} from "./resources/analysisResource.js";

import { buildRewriteClaudePrompt, RewriteClaudeInputSchema } from "./prompts/rewriteClaude.js";
import { buildSummarizePrompt, SummarizeInputSchema } from "./prompts/summarize.js";

import { createLogger } from "../core/audit/logger.js";
import { generateSuggestions } from "../core/engine/suggestionEngine.js";
import { createUpdatePlan } from "../core/engine/updatePlanner.js";
import { profileLocalRepo } from "../core/analysis/dnaProfiler.js";
import { compareWithLocal } from "../core/analysis/comparator.js";
import { extractPatterns } from "../core/analysis/patternExtractor.js";

const logger = createLogger("mcp:server");

// Tool definitions for schema exposure
const TOOL_DEFINITIONS = [
  {
    name: "scan_github_trends",
    description:
      "Scan GitHub for high-signal repositories related to Claude Code, MCP servers, and AI developer workflows. Returns ranked repos with relevance scores.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Additional search topics to include",
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score for inclusion (0-1)",
          default: 0.4,
        },
        maxRepos: {
          type: "number",
          description: "Maximum number of repos to return",
          default: 20,
        },
        includeReadme: {
          type: "boolean",
          description: "Fetch READMEs for more accurate scoring (slower)",
          default: false,
        },
      },
    },
  },
  {
    name: "rank_repositories",
    description:
      "Rank a list of GitHub repositories by their relevance to Claude Code development. Returns repos sorted by score with detailed breakdown.",
    inputSchema: {
      type: "object" as const,
      required: ["repos"],
      properties: {
        repos: {
          type: "array",
          description: "Array of GitHub repo objects to rank",
        },
        readmes: {
          type: "object",
          description: "Optional map of full_name → readme content for better scoring",
        },
      },
    },
  },
  {
    name: "compare_with_local_repo",
    description:
      "Compare an external GitHub repository's patterns against your local project. Identifies gaps, enhancements, and conflicts.",
    inputSchema: {
      type: "object" as const,
      required: ["repoFullName"],
      properties: {
        repoFullName: {
          type: "string",
          description: "Full repository name in format 'owner/repo'",
        },
        localPath: {
          type: "string",
          description: "Path to the local repository (defaults to cwd)",
        },
      },
    },
  },
  {
    name: "generate_claude_md_patch",
    description:
      "Generate a unified diff patch for CLAUDE.md based on improvement suggestions. Use dryRun=true (default) to preview without writing.",
    inputSchema: {
      type: "object" as const,
      required: ["suggestions"],
      properties: {
        suggestions: {
          type: "array",
          description: "List of suggestions to build patches for",
        },
        dryRun: {
          type: "boolean",
          description: "Preview only without writing files",
          default: true,
        },
      },
    },
  },
  {
    name: "apply_safe_updates",
    description:
      "Apply a safe, non-destructive update to CLAUDE.md. Requires explicit confirm=true. Creates a backup before applying.",
    inputSchema: {
      type: "object" as const,
      required: ["suggestion", "confirm"],
      properties: {
        suggestion: {
          type: "object",
          description: "The suggestion to apply",
        },
        confirm: {
          type: "boolean",
          description: "Must be explicitly true to apply changes",
        },
      },
    },
  },
  {
    name: "generate_suggestions",
    description:
      "Generate improvement suggestions by running a full scan → classify → compare pipeline against the local repo.",
    inputSchema: {
      type: "object" as const,
      properties: {
        maxRepos: {
          type: "number",
          description: "Number of repos to scan",
          default: 10,
        },
        localPath: {
          type: "string",
          description: "Local repo path to analyze (defaults to cwd)",
        },
      },
    },
  },
  {
    name: "create_update_plan",
    description: "Create a structured update plan from a list of suggestions, grouped into phases.",
    inputSchema: {
      type: "object" as const,
      required: ["suggestions"],
      properties: {
        suggestions: {
          type: "array",
          description: "List of suggestions to plan",
        },
      },
    },
  },
];

const RESOURCE_DEFINITIONS = [
  {
    uri: "github://latest-trends",
    name: "Latest GitHub Trends",
    description: "Most recent scan results from GitHub trend analysis",
    mimeType: "application/json",
  },
  {
    uri: "github://ranked-repos",
    name: "Ranked Repositories",
    description: "Current ranked list of relevant repositories",
    mimeType: "application/json",
  },
  {
    uri: "local://dna-profile",
    name: "Local Repo DNA Profile",
    description: "Detected stack, languages, frameworks, and conventions of the local repository",
    mimeType: "application/json",
  },
  {
    uri: "local://gap-analysis",
    name: "Gap Analysis",
    description: "Identified gaps between local project and best practices from external repos",
    mimeType: "application/json",
  },
  {
    uri: "local://claude-md-current",
    name: "Current CLAUDE.md",
    description: "Current content of the local CLAUDE.md file",
    mimeType: "application/json",
  },
  {
    uri: "local://claude-md-proposed",
    name: "Proposed CLAUDE.md Changes",
    description: "Proposed additions and changes to CLAUDE.md based on analysis",
    mimeType: "application/json",
  },
  {
    uri: "audit://learning-log",
    name: "Learning Log",
    description: "Historical audit log of all scan, compare, and apply events",
    mimeType: "application/json",
  },
];

const PROMPT_DEFINITIONS = [
  {
    name: "rewrite_claude_md",
    description:
      "Generate a prompt to ask Claude to rewrite/improve CLAUDE.md incorporating suggestions from the analysis",
    arguments: [
      {
        name: "focus",
        description: "Specific sections to focus on",
        required: false,
      },
      {
        name: "topRepos",
        description: "Names of top-scoring repos to use as reference",
        required: false,
      },
      {
        name: "suggestions",
        description: "Brief list of suggested improvements",
        required: false,
      },
    ],
  },
  {
    name: "summarize_insights",
    description: "Generate a prompt to summarize all findings from the scan and analysis",
    arguments: [
      {
        name: "repos",
        description: "Ranked repos to summarize",
        required: false,
      },
      {
        name: "gaps",
        description: "Identified gaps",
        required: false,
      },
      {
        name: "suggestions",
        description: "Improvement suggestions",
        required: false,
      },
    ],
  },
];

export async function createMcpServer(): Promise<Server> {
  const server = new Server(
    {
      name: "claude-intel-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // ---- Tool Handlers ----

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool called", { tool: name });

    try {
      switch (name) {
        case "scan_github_trends": {
          const input = ScanTrendsInputSchema.parse(args ?? {});
          const result = await scanTrends(input);

          // Update cache for resources
          updateTrendsCache({
            repos: result.repos,
            scanTime: result.scanTime,
            totalScanned: result.totalScanned,
          });

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "rank_repositories": {
          const input = RankReposInputSchema.parse(args ?? {});
          const result = await rankRepos(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "compare_with_local_repo": {
          const input = CompareRepoInputSchema.parse(args ?? {});
          const result = await compareRepo(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "generate_claude_md_patch": {
          const input = GeneratePatchInputSchema.parse(args ?? {});
          const result = await generatePatch(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "apply_safe_updates": {
          const input = ApplyUpdatesInputSchema.parse(args ?? {});
          const result = await applyUpdates(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        case "generate_suggestions": {
          const parsed = z
            .object({
              maxRepos: z.number().optional().default(10),
              localPath: z.string().optional(),
            })
            .parse(args ?? {});

          // Run mini-scan pipeline
          const { GithubCollector } = await import("../core/github/githubCollector.js");
          const { classifyBatch } = await import("../core/analysis/repoClassifier.js");
          const { scoreBatch } = await import("../core/analysis/relevanceScorer.js");
          const { GithubClient } = await import("../core/github/githubClient.js");

          const client = new GithubClient();
          const collector = new GithubCollector(client);
          const collected = await collector.collect();
          const classified = classifyBatch(collected);
          const scored = scoreBatch(classified);
          const topScored = scored.slice(0, parsed.maxRepos);

          const dna = profileLocalRepo(parsed.localPath);
          const comparisons = [];

          for (const repo of topScored.slice(0, 5)) {
            try {
              // Extract patterns from available data (no full file fetch in this flow)
              const patterns = extractPatterns({
                readme: "",
                claudeMd: "",
              });
              const comparison = compareWithLocal(patterns, dna, repo.repo.full_name);
              comparisons.push(comparison);
            } catch {
              // skip
            }
          }

          const suggestions = generateSuggestions(comparisons, topScored);
          return {
            content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }],
          };
        }

        case "create_update_plan": {
          const parsed = z
            .object({
              suggestions: z.array(z.unknown()),
            })
            .parse(args ?? {});

          // Validate suggestion shape
          const suggestions = parsed.suggestions.map((s) =>
            z
              .object({
                id: z.string(),
                level: z.enum(["micro", "meso", "macro"]),
                title: z.string(),
                description: z.string(),
                reasoning: z.string(),
                sourceRepo: z.string(),
                confidence: z.number(),
                estimatedImpact: z.number(),
                implementation: z.string(),
                tags: z.array(z.string()),
                relatedSuggestions: z.array(z.string()),
              })
              .parse(s)
          );

          const plan = createUpdatePlan(suggestions);
          return {
            content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      logger.error("Tool error", { tool: name, error: String(err) });
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  // ---- Resource Handlers ----

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCE_DEFINITIONS,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    logger.debug("Resource read", { uri });

    let content: string;

    switch (uri) {
      case "github://latest-trends":
        content = getLatestTrendsContent();
        break;
      case "github://ranked-repos":
        content = getRankedReposContent();
        break;
      case "local://dna-profile":
        content = getDnaProfileContent();
        break;
      case "local://gap-analysis":
        content = getGapAnalysisContent();
        break;
      case "local://claude-md-current":
        content = getCurrentClaudeMdContent();
        break;
      case "local://claude-md-proposed":
        content = getProposedClaudeMdContent();
        break;
      case "audit://learning-log":
        content = getLearningLogContent();
        break;
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: content,
        },
      ],
    };
  });

  // ---- Prompt Handlers ----

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPT_DEFINITIONS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;
    logger.debug("Prompt requested", { name });

    switch (name) {
      case "rewrite_claude_md": {
        const input = RewriteClaudeInputSchema.parse({
          focus: promptArgs?.["focus"] ? String(promptArgs["focus"]).split(",") : undefined,
          topRepos: promptArgs?.["topRepos"] ? String(promptArgs["topRepos"]).split(",") : undefined,
          suggestions: promptArgs?.["suggestions"]
            ? String(promptArgs["suggestions"]).split(",")
            : undefined,
        });

        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: buildRewriteClaudePrompt(input),
              },
            },
          ],
        };
      }

      case "summarize_insights": {
        const input = SummarizeInputSchema.parse({});
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: buildSummarizePrompt(input),
              },
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });

  logger.info("MCP server created", { tools: TOOL_DEFINITIONS.length, resources: RESOURCE_DEFINITIONS.length });
  return server;
}

export async function startServer(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
  logger.info("claude-intel-mcp started and listening on stdio");
}
