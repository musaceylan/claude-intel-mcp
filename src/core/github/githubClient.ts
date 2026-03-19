import { getConfig } from "../../config/config.js";
import { createLogger } from "../audit/logger.js";

const logger = createLogger("githubClient");

export interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics: string[];
  language: string | null;
  pushed_at: string;
  created_at: string;
  updated_at: string;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  license: { key: string; name: string } | null;
  owner: {
    login: string;
    type: string;
  };
  default_branch: string;
  size: number;
  watchers_count: number;
  has_issues: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  subscribers_count: number;
}

export interface GithubSearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: GithubRepo[];
}

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

export interface GithubFileContent {
  type: string;
  encoding: string;
  size: number;
  name: string;
  path: string;
  content: string;
  sha: string;
  url: string;
}

export interface GithubContributor {
  login: string;
  contributions: number;
  type: string;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GithubClient {
  private readonly token: string | undefined;
  private readonly apiBase: string;
  private rateLimitRemaining = 60;
  private rateLimitReset = 0;

  constructor() {
    const cfg = getConfig();
    this.token = cfg.githubToken;
    this.apiBase = cfg.githubApiBase;

    if (!this.token) {
      logger.warn("No GITHUB_TOKEN set — rate limits will be severely restricted (60 req/hr)");
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claude-intel-mcp/1.0.0",
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    return headers;
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");

    if (remaining !== null) this.rateLimitRemaining = parseInt(remaining, 10);
    if (reset !== null) this.rateLimitReset = parseInt(reset, 10) * 1000;

    if (this.rateLimitRemaining <= 5) {
      logger.warn("GitHub rate limit nearly exhausted", {
        remaining: this.rateLimitRemaining,
        resetAt: new Date(this.rateLimitReset).toISOString(),
      });
    }
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.rateLimitRemaining > 0) return;

    const now = Date.now();
    const waitMs = Math.max(0, this.rateLimitReset - now + 1000);

    if (waitMs > 0) {
      logger.info(`Rate limited — waiting ${Math.ceil(waitMs / 1000)}s for reset`);
      await sleep(waitMs);
    }
  }

  private async fetchWithRetry<T>(url: string, attempt = 0): Promise<T> {
    await this.waitForRateLimit();

    let response: Response;

    try {
      response = await fetch(url, { headers: this.buildHeaders() });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn(`Network error fetching ${url}, retry ${attempt + 1}/${MAX_RETRIES}`, {
          error: String(err),
          backoffMs: backoff,
        });
        await sleep(backoff);
        return this.fetchWithRetry<T>(url, attempt + 1);
      }
      throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} retries: ${String(err)}`);
    }

    this.updateRateLimit(response.headers);

    if (response.status === 429 || response.status === 403) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_BACKOFF_MS * Math.pow(2, attempt);

      if (attempt < MAX_RETRIES) {
        logger.warn(`Rate limited (${response.status}), waiting ${waitMs}ms before retry`);
        await sleep(waitMs);
        return this.fetchWithRetry<T>(url, attempt + 1);
      }
    }

    if (response.status === 404) {
      throw new Error(`Resource not found: ${url}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub API error ${response.status} for ${url}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async searchRepos(
    query: string,
    sort: "stars" | "forks" | "updated" | "best-match" = "stars",
    order: "asc" | "desc" = "desc",
    perPage = 30
  ): Promise<GithubSearchResult> {
    const params = new URLSearchParams({
      q: query,
      sort: sort === "best-match" ? "" : sort,
      order,
      per_page: String(Math.min(perPage, 100)),
    });

    if (sort === "best-match") params.delete("sort");

    const url = `${this.apiBase}/search/repositories?${params.toString()}`;
    logger.debug("Searching repos", { query, sort, perPage });
    return this.fetchWithRetry<GithubSearchResult>(url);
  }

  async getRepo(owner: string, repo: string): Promise<GithubRepo> {
    const url = `${this.apiBase}/repos/${owner}/${repo}`;
    return this.fetchWithRetry<GithubRepo>(url);
  }

  async getReadme(owner: string, repo: string): Promise<string> {
    try {
      const url = `${this.apiBase}/repos/${owner}/${repo}/readme`;
      const data = await this.fetchWithRetry<GithubFileContent>(url);
      if (data.encoding === "base64") {
        return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
      }
      return data.content;
    } catch (err) {
      if (String(err).includes("not found")) return "";
      throw err;
    }
  }

  async getFileContents(owner: string, repo: string, path: string): Promise<string> {
    try {
      const url = `${this.apiBase}/repos/${owner}/${repo}/contents/${path}`;
      const data = await this.fetchWithRetry<GithubFileContent>(url);
      if (data.encoding === "base64") {
        return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
      }
      return data.content;
    } catch (err) {
      if (String(err).includes("not found")) return "";
      throw err;
    }
  }

  async getTopics(owner: string, repo: string): Promise<string[]> {
    try {
      const url = `${this.apiBase}/repos/${owner}/${repo}/topics`;
      const data = await this.fetchWithRetry<{ names: string[] }>(url);
      return data.names;
    } catch {
      return [];
    }
  }

  async getContributors(owner: string, repo: string): Promise<GithubContributor[]> {
    try {
      const url = `${this.apiBase}/repos/${owner}/${repo}/contributors?per_page=30`;
      return this.fetchWithRetry<GithubContributor[]>(url);
    } catch {
      return [];
    }
  }

  getRateLimitInfo(): { remaining: number; resetAt: Date } {
    return {
      remaining: this.rateLimitRemaining,
      resetAt: new Date(this.rateLimitReset),
    };
  }
}
