import { Router, Request, Response } from "express";
import { config } from "../config.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";

export function createRouter(
  projectManager: ProjectManager,
  workerManager: WorkerManager
): Router {
  const router = Router();

  // ---- Projects ----

  router.get("/api/projects", (_req: Request, res: Response) => {
    const projects = projectManager.list();
    const workers = workerManager.listActive();
    const enriched = projects.map((p) => ({
      ...p,
      activeWorker: workers.find((w) => w.project_id === p.id) || null,
    }));
    res.json(enriched);
  });

  router.get("/api/projects/:id", (req: Request, res: Response) => {
    const project = projectManager.get(req.params.id);
    if (!project) return res.status(404).json({ error: "Not found" });

    const worker = workerManager.getForProject(project.id);
    const brief = projectManager.getBrief(project.id);
    const events = projectManager.getRecentEvents(project.id, 50);

    res.json({ ...project, activeWorker: worker || null, brief, events });
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
    const all = workerManager.listAll();
    res.json(all);
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

  // ---- Health ----

  router.get("/api/health", (_req: Request, res: Response) => {
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
  });

  return router;
}
