import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";

export function createRouter(
  projectManager: ProjectManager,
  workerManager: WorkerManager
): Router {
  const router = Router();

  // ---- Projects ----

  router.get("/api/projects", (_req: Request, res: Response) => {
    try {
      const projects = projectManager.list();
      const workers = workerManager.listActive();
      const enriched = projects.map((p) => ({
        ...p,
        activeWorker: workers.find((w) => w.project_id === p.id) || null,
      }));
      res.json(enriched);
    } catch (err: any) {
      logger.error(`GET /api/projects failed: ${err}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/projects/:id", (req: Request, res: Response) => {
    try {
      const project = projectManager.get(req.params.id);
      if (!project) return res.status(404).json({ error: "Not found" });

      const worker = workerManager.getForProject(project.id);
      const brief = projectManager.getBrief(project.id);
      const events = projectManager.getRecentEvents(project.id, 50);

      res.json({ ...project, activeWorker: worker || null, brief, events });
    } catch (err: any) {
      logger.error(`GET /api/projects/:id failed: ${err}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/projects", async (req: Request, res: Response) => {
    try {
      const project = await projectManager.create(req.body);
      res.status(201).json(project);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Workers ----

  router.get("/api/workers", (_req: Request, res: Response) => {
    try {
      const all = workerManager.listAll();
      res.json(all);
    } catch (err: any) {
      logger.error(`GET /api/workers failed: ${err}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/workers", async (req: Request, res: Response) => {
    try {
      const { projectId, prompt, branch } = req.body;
      const worker = await workerManager.spawn({ projectId, prompt, branch });
      res.status(201).json(worker);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/api/workers/:id/pause", async (req: Request, res: Response) => {
    try {
      await workerManager.pause(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/api/workers/:id/stop", async (req: Request, res: Response) => {
    try {
      await workerManager.stop(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/api/workers/:id/message", (req: Request, res: Response) => {
    try {
      workerManager.sendMessage(req.params.id, req.body.message);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/api/workers/:id/logs", (req: Request, res: Response) => {
    try {
      const lines = parseInt(req.query.lines as string) || 50;
      const output = workerManager.getOutput(req.params.id, lines);
      res.json({ output });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Resume ----

  router.post("/api/projects/:id/resume", async (req: Request, res: Response) => {
    try {
      const worker = await workerManager.resume(req.params.id, req.body.prompt);
      res.status(201).json(worker);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Terminal launcher (.command file for macOS Terminal.app) ----

  router.get("/api/terminal-launch", (req: Request, res: Response) => {
    try {
      const projectName = req.query.project as string;
      if (!projectName) return res.status(400).json({ error: "Missing ?project= parameter" });

      const project = projectManager.getByName(projectName);
      if (!project) return res.status(404).json({ error: `Project "${projectName}" not found` });

      const tmuxSession = `feral-${project.name}`;

      // Generate a .command file — macOS opens these in Terminal.app automatically
      const script = [
        "#!/bin/bash",
        '# Feral terminal launcher — auto-generated',
        `# Project: ${project.name}`,
        "",
        `TMUX_SESSION="${tmuxSession}"`,
        "",
        "# Find tmux (Homebrew or system)",
        'TMUX_BIN=""',
        'for p in /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux; do',
        '  if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi',
        "done",
        "",
        'if [ -z "$TMUX_BIN" ]; then',
        '  echo "Error: tmux not found. Install it with: brew install tmux"',
        '  echo "Press any key to close..."',
        "  read -n1",
        "  exit 1",
        "fi",
        "",
        '# Check if session exists',
        'if ! "$TMUX_BIN" has-session -t "$TMUX_SESSION" 2>/dev/null; then',
        `  echo "No active tmux session '$TMUX_SESSION'."`,
        '  echo "Start a worker for this project first."',
        '  echo ""',
        '  echo "Press any key to close..."',
        "  read -n1",
        "  exit 1",
        "fi",
        "",
        '# Attach to the session',
        'echo "Attaching to $TMUX_SESSION..."',
        '"$TMUX_BIN" attach-session -t "$TMUX_SESSION"',
        "",
      ].join("\n");

      const filename = `feral-terminal-${project.name}.command`;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      // .command files need to be executable
      res.send(script);
    } catch (err: any) {
      logger.error(`GET /api/terminal-launch failed: ${err}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Health ----

  router.get("/api/health", (_req: Request, res: Response) => {
    try {
      const active = workerManager.listActive();
      const projects = projectManager.list();
      res.json({
        status: "ok",
        uptime: process.uptime(),
        projects: projects.length,
        activeWorkers: active.length,
        maxWorkers: config.maxWorkers,
        pausedProjects: projects.filter((p) => p.status === "paused").length,
        totalMessages: active.reduce((sum, w) => sum + (w.message_count || 0), 0),
      });
    } catch (err: any) {
      logger.error(`GET /api/health failed: ${err}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
