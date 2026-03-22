import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ProjectManager } from "./managers/project-manager.js";
import { WorkerManager } from "./managers/worker-manager.js";
import { SlackBot } from "./bot/slack-bot.js";
import { createRouter } from "./api/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  logger.info("Feral starting...");
  logger.info(`Projects dir: ${config.projectsDir}`);
  logger.info(`Max workers: ${config.maxWorkers}`);

  // Initialize managers
  const projectManager = new ProjectManager();
  const workerManager = new WorkerManager(projectManager);

  // Start Express server
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(createRouter(projectManager, workerManager));

  // Serve dashboard static files
  const dashboardPath = path.join(__dirname, "..", "dashboard");
  app.use(express.static(dashboardPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardPath, "index.html"));
  });

  app.listen(config.port, () => {
    logger.info(`Dashboard: http://localhost:${config.port}`);
  });

  // Start Slack bot
  const slackBot = new SlackBot(projectManager, workerManager);
  await slackBot.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received. Shutting down gracefully...`);

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
