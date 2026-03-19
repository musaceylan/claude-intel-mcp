#!/usr/bin/env node
import { startServer } from "./mcp/server.js";
import { createLogger } from "./core/audit/logger.js";

const logger = createLogger("main");

logger.info("claude-intel-mcp starting...", {
  node: process.version,
  pid: process.pid,
  cwd: process.cwd(),
});

startServer().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
