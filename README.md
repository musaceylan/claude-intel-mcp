# claude-intel-mcp

An auto-evolving developer intelligence layer for Claude Code.

`claude-intel-mcp` continuously scans high-signal GitHub repositories, extracts patterns, compares them against your local project, and proposes safe improvements to your `CLAUDE.md` — keeping your Claude Code setup ahead of the curve.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     claude-intel-mcp                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  MCP Server (stdio)                                  │    │
│  │   ├── Tools (7)    ├── Resources (7)  ├── Prompts (2)│    │
│  └──────────────────────────────────────────────────────┘    │
│            │                                                 │
│  ┌─────────▼─────────────────────────────────────┐          │
│  │  Core Engine                                   │          │
│  │   ├── GithubClient (API + rate limiting)       │          │
│  │   ├── GithubCollector (multi-query search)     │          │
│  │   ├── RepoClassifier (hype/abandoned/mcp...)   │          │
│  │   ├── RelevanceScorer (5-factor, 0-1 score)    │          │
│  │   ├── PatternExtractor (CLAUDE.md/MCP/config)  │          │
│  │   ├── PatternMemory (SQLite, deduped)          │          │
│  │   ├── DnaProfiler (local stack detection)      │          │
│  │   ├── Comparator (gap/enhancement analysis)   │          │
│  │   ├── SuggestionEngine (micro/meso/macro)      │          │
│  │   ├── PatchBuilder (safe unified diffs)        │          │
│  │   ├── UpdatePlanner (phased update plans)      │          │
│  │   └── LearningLog (SQLite audit trail)         │          │
│  └───────────────────────────────────────────────┘          │
│                                                              │
│  ┌─────────────────────────────┐                            │
│  │  Storage (~/.claude-intel/) │                            │
│  │   ├── patterns.db           │                            │
│  │   ├── learning.db           │                            │
│  │   ├── backups/              │                            │
│  │   └── claude-intel.log      │                            │
│  └─────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────┘
```

## Installation

### Option 1: Clone & Build (recommended for hacking)

```bash
git clone git@github.com:musaceylan/claude-intel-mcp.git
cd claude-intel-mcp
npm install
npm run build
```

### Option 2: Run with tsx (development)

```bash
npm run dev
```

## Configuration

Set in your environment or `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub personal access token (60→5000 req/hr) |
| `GITHUB_API_BASE` | `https://api.github.com` | Override for GitHub Enterprise |
| `MAX_REPOS_PER_SCAN` | `50` | Max repos to collect per scan |
| `SCAN_INTERVAL_HOURS` | `24` | Interval for scheduled scans |
| `MIN_RELEVANCE_SCORE` | `0.6` | Minimum score to include a repo |
| `LOCAL_REPO_PATH` | `process.cwd()` | Path to your local repository |
| `CLAUDE_INTEL_DATA_DIR` | `~/.claude-intel` | Where to store DB and logs |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## MCP Configuration

Add to your Claude Code `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-intel": {
      "command": "node",
      "args": ["/path/to/claude-intel-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here",
        "LOCAL_REPO_PATH": "/path/to/your/project"
      }
    }
  }
}
```

Or with `npx` (after publishing):

```json
{
  "mcpServers": {
    "claude-intel": {
      "command": "npx",
      "args": ["claude-intel-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

## Tools

### `scan_github_trends`
Scan GitHub for high-signal repositories related to Claude Code, MCP servers, and AI workflows.

```json
{
  "topics": ["mcp", "claude"],
  "minScore": 0.5,
  "maxRepos": 20,
  "includeReadme": false
}
```

Returns: ranked repos with relevance scores, category breakdowns, and signals.

---

### `rank_repositories`
Rank a provided list of GitHub repos by relevance to Claude Code development.

```json
{
  "repos": [...githubRepoObjects],
  "readmes": { "owner/repo": "readme content" }
}
```

---

### `compare_with_local_repo`
Compare an external repo's patterns against your local project. Identifies gaps, enhancements, and conflicts.

```json
{
  "repoFullName": "anthropic/anthropic-sdk-python",
  "localPath": "/path/to/your/project"
}
```

Returns: gap analysis with severity levels, enhancement opportunities, conflicts, and fit score.

---

### `generate_claude_md_patch`
Build unified diff patches for CLAUDE.md based on suggestions. Non-destructive by design.

```json
{
  "suggestions": [...suggestionObjects],
  "dryRun": true
}
```

Returns: patch previews with diffs, destructiveness flags, and review requirements.

---

### `apply_safe_updates`
Apply a safe patch to CLAUDE.md. Requires `confirm: true`. Creates automatic backup.

```json
{
  "suggestion": { ...suggestionObject },
  "confirm": true
}
```

Safety: only `micro`-level suggestions can be auto-applied. Macro/meso require manual review.

---

### `generate_suggestions`
Run a full scan → classify → compare pipeline and return improvement suggestions.

```json
{
  "maxRepos": 10,
  "localPath": "/path/to/project"
}
```

---

### `create_update_plan`
Create a phased update plan from suggestions.

```json
{
  "suggestions": [...suggestionObjects]
}
```

Returns: 3-phase plan (micro → meso → macro) with effort estimates and risks.

## Resources

| URI | Description |
|-----|-------------|
| `github://latest-trends` | Most recent scan results |
| `github://ranked-repos` | Current ranked repo list |
| `local://dna-profile` | Detected stack, languages, frameworks |
| `local://gap-analysis` | Identified gaps vs best practices |
| `local://claude-md-current` | Current CLAUDE.md content |
| `local://claude-md-proposed` | Proposed additions |
| `audit://learning-log` | Historical audit trail |

## Prompts

### `rewrite_claude_md`
Generates a prompt asking Claude to intelligently rewrite your CLAUDE.md incorporating analysis findings.

### `summarize_insights`
Generates an executive summary prompt for all scan and analysis findings.

## Typical Workflow

```
1. scan_github_trends            → find relevant repos
2. compare_with_local_repo       → analyze top repos vs local
3. generate_suggestions          → get improvement list
4. generate_claude_md_patch      → preview diffs (dryRun=true)
5. apply_safe_updates            → apply when satisfied (confirm=true)
6. Use prompt: summarize_insights → get executive summary
```

## Running Tests

```bash
npm test
```

```bash
npm run test:watch
```

## Building

```bash
npm run build          # TypeScript → dist/
npm run typecheck      # Type check only
npm run lint           # ESLint
```

## Safety Guarantees

- **Never destructive**: patches only append, never remove existing content
- **Always backs up**: creates `.bak` file before any write
- **Requires confirmation**: `apply_safe_updates` needs explicit `confirm: true`
- **Level gating**: only `micro` (CLAUDE.md) suggestions auto-apply; `meso`/`macro` require manual review
- **Annotated additions**: all AI-suggested content is marked with `<!-- claude-intel: source=... -->`

## License

MIT
