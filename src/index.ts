import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ProjectManager } from "./managers/project-manager.js";
import { WorkerManager } from "./managers/worker-manager.js";
import { createServer } from "http";
import { SlackBot } from "./bot/slack-bot.js";
import { DiscordBot } from "./bot/discord-bot.js";
import { createRouter } from "./api/routes.js";
import { attachTerminalServer } from "./terminal/terminal-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  logger.info("Feral starting...");
  logger.info(`Projects dir: ${config.projectsDir}`);
  logger.info(`Max workers: ${config.maxWorkers}`);

  // Initialize managers
  const projectManager = new ProjectManager();
  const workerManager = new WorkerManager(projectManager);

  // Start worker health checks (detects dead tmux sessions)
  workerManager.startHealthCheck();

  // Start Express server
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(createRouter(projectManager, workerManager));

  // Serve dashboard static files
  const dashboardPath = path.join(__dirname, "..", "dashboard");
  app.use(express.static(dashboardPath));

  // Terminal page gets its own route (before the wildcard)
  app.get("/terminal", (_req, res) => {
    res.sendFile(path.join(dashboardPath, "terminal.html"));
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardPath, "index.html"));
  });

  // Global error handler — catches anything the route-level try/catch missed
  app.use((err: any, _req: any, res: any, _next: any) => {
    logger.error(`Unhandled Express error: ${err.stack || err}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Prevent unhandled rejections from crashing the process
  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
  });
  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.stack || err}`);
    // Don't exit — keep the server running
  });

  // Use HTTP server so WebSocket can share the same port
  const server = createServer(app);

  // Attach web terminal WebSocket server
  attachTerminalServer(server, projectManager, workerManager);

  server.listen(config.port, () => {
    logger.info(`Dashboard: http://localhost:${config.port}`);
    logger.info(`Terminal: http://localhost:${config.port}/terminal`);
  });

  // Start chat integrations (non-fatal — server works without them)
  try {
    const slackBot = new SlackBot(projectManager, workerManager);
    await slackBot.start();
  } catch (err) {
    if (config.slack.enabled) {
      logger.error(`Slack bot failed to start: ${err}`);
      logger.error("Feral will continue running without Slack integration.");
    } else {
      logger.info("Slack not configured — running without Slack integration.");
    }
  }

  try {
    const discordBot = new DiscordBot(projectManager, workerManager);
    await discordBot.start();
  } catch (err) {
    if (config.discord.enabled) {
      logger.error(`Discord bot failed to start: ${err}`);
      logger.error("Feral will continue running without Discord integration.");
    } else {
      logger.info("Discord not configured — running without Discord integration.");
    }
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received. Shutting down gracefully...`);

    workerManager.stopOutputPolling();
    workerManager.stopHealthCheck();

    // Pause all active workers (preserves state)
    const active = workerManager.listActive();
    for (const worker of active) {
      try {
        await workerManager.pause(worker.id);
        logger.info(`Paused worker: ${worker.id}`);
      } catch (err) {
        logger.warn(`Failed to pause worker ${worker.id}: ${err}`);
      }
    }

    logger.info("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Feral is running.");
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
