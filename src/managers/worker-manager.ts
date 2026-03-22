import { randomUUID } from "crypto";
import { execSync, spawn, ChildProcess } from "child_process";
import { config } from "../config.js";
import { queries } from "../db/database.js";
import { logger } from "../logger.js";
import { ProjectManager, Project } from "./project-manager.js";
import fs from "fs";
import path from "path";

export interface Worker {
  id: string;
  project_id: string;
  project_name?: string;
  session_id: string | null;
  session_name: string | null;
  branch: string;
  worktree_path: string | null;
  status: string;
  message_count: number;
  last_summary: string | null;
  started_at: string;
  stopped_at: string | null;
  updated_at: string;
}

export interface SpawnWorkerOptions {
  projectId: string;
  prompt: string;
  branch?: string;
  useWorktree?: boolean;
  resume?: boolean;
}

export class WorkerManager {
  private processes: Map<string, ChildProcess> = new Map();
  private projectManager: ProjectManager;

  constructor(projectManager: ProjectManager) {
    this.projectManager = projectManager;
  }

  /**
   * Spawn a new Claude Code worker for a project.
   */
  async spawn(options: SpawnWorkerOptions): Promise<Worker> {
    const { projectId, prompt, branch = "main", useWorktree = true } = options;

    const project = this.projectManager.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Check active worker limit
    const activeWorkers = this.listActive();
    if (activeWorkers.length >= config.maxWorkers) {
      throw new Error(
        `Maximum active workers reached (${config.maxWorkers}). ` +
        `Pause or stop a worker first.`
      );
    }

    // Check if project already has an active worker
    const existing = queries.getActiveWorkerForProject.get(projectId) as Worker | undefined;
    if (existing) {
      throw new Error(
        `Project "${project.name}" already has an active worker (${existing.id}). ` +
        `Stop it first or resume it.`
      );
    }

    const workerId = `worker-${Date.now()}`;
    const sessionName = `${project.name}-${branch}`;
    let worktreePath = project.path;

    // Create git worktree if using a non-main branch
    if (useWorktree && branch !== "main") {
      worktreePath = path.join(config.projectsDir, ".worktrees", `${project.name}-${branch}`);
      try {
        execSync(`git worktree add "${worktreePath}" -b "${branch}" 2>/dev/null || git worktree add "${worktreePath}" "${branch}"`, {
          cwd: project.path,
          stdio: "pipe",
        });
        logger.info(`Created worktree: ${worktreePath} on branch ${branch}`);
      } catch (err) {
        logger.warn(`Worktree creation failed, using main path: ${err}`);
        worktreePath = project.path;
      }
    }

    // Check if we should resume a previous session
    let resumeFlag = "";
    if (options.resume) {
      const lastWorker = queries.getLastWorkerForProject.get(projectId) as Worker | undefined;
      if (lastWorker?.session_id) {
        resumeFlag = `--resume "${lastWorker.session_id}"`;
        logger.info(`Resuming session: ${lastWorker.session_id}`);
      }
    }

    // Inject project brief into prompt if resuming
    let fullPrompt = prompt;
    if (options.resume) {
      const brief = this.projectManager.getBrief(projectId);
      if (brief) {
        fullPrompt = `You are resuming work on this project. Here is the project brief:\n\n${brief}\n\n---\n\nNew instructions: ${prompt}`;
      }
    }

    // Save worker record
    queries.createWorker.run(workerId, projectId, null, sessionName, branch, worktreePath);
    this.projectManager.setStatus(projectId, "active");

    // Spawn Claude Code in a tmux session
    const tmuxSession = `farm-${project.name}`;
    const claudeCmd = [
      "claude",
      "-p", JSON.stringify(fullPrompt),
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--name", sessionName,
      resumeFlag,
    ].filter(Boolean).join(" ");

    try {
      // Kill existing tmux session if any
      try { execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`); } catch { /* ignore */ }

      // Start new tmux session with Claude Code
      execSync(
        `tmux new-session -d -s "${tmuxSession}" -c "${worktreePath}" '${claudeCmd}'`,
        {
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: config.anthropicApiKey,
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
          stdio: "pipe",
        }
      );

      queries.updateWorkerStatus.run("running", workerId);
      queries.addEvent.run(projectId, workerId, "worker_started", `Worker started on branch ${branch}`);
      logger.info(`Worker spawned: ${workerId} for ${project.name} on ${branch}`, { tmuxSession });

    } catch (err) {
      queries.updateWorkerStatus.run("error", workerId);
      queries.addEvent.run(projectId, workerId, "worker_error", `Failed to spawn: ${err}`);
      throw err;
    }

    return queries.getWorker.get(workerId) as Worker;
  }

  /**
   * Pause a worker — captures state and tears down tmux session.
   */
  async pause(workerId: string): Promise<void> {
    const worker = queries.getWorker.get(workerId) as Worker | undefined;
    if (!worker) throw new Error(`Worker not found: ${workerId}`);

    const project = this.projectManager.get(worker.project_id);
    if (!project) throw new Error(`Project not found for worker`);

    const tmuxSession = `farm-${project.name}`;

    // Capture last output as summary
    try {
      const output = execSync(
        `tmux capture-pane -t "${tmuxSession}" -p -S -50`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      queries.updateWorkerSummary.run(output.slice(-2000), worker.message_count, workerId);
    } catch { /* tmux session may already be gone */ }

    // Generate project brief before pausing
    await this.updateProjectBrief(worker, project);

    // Kill tmux session
    try {
      execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`);
    } catch { /* ignore */ }

    queries.pauseWorker.run(workerId);
    this.projectManager.setStatus(worker.project_id, "paused");
    queries.addEvent.run(worker.project_id, workerId, "worker_paused", "Worker paused");
    logger.info(`Worker paused: ${workerId}`);
  }

  /**
   * Resume a paused project by spawning a new worker with session history.
   */
  async resume(projectId: string, additionalPrompt?: string): Promise<Worker> {
    const project = this.projectManager.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const lastWorker = queries.getLastWorkerForProject.get(projectId) as Worker | undefined;
    const prompt = additionalPrompt || "Continue where you left off. Check PROJECT_BRIEF.md for context.";
    const branch = lastWorker?.branch || "main";

    return this.spawn({
      projectId,
      prompt,
      branch,
      useWorktree: branch !== "main",
      resume: true,
    });
  }

  /**
   * Stop a worker permanently.
   */
  async stop(workerId: string): Promise<void> {
    const worker = queries.getWorker.get(workerId) as Worker | undefined;
    if (!worker) throw new Error(`Worker not found: ${workerId}`);

    const project = this.projectManager.get(worker.project_id);
    const tmuxSession = project ? `farm-${project.name}` : null;

    if (tmuxSession) {
      try { execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`); } catch { /* ignore */ }
    }

    if (project) {
      await this.updateProjectBrief(worker, project);
    }

    queries.stopWorker.run(workerId);
    if (project) {
      this.projectManager.setStatus(worker.project_id, "idle");
    }
    queries.addEvent.run(worker.project_id, workerId, "worker_stopped", "Worker stopped");
    logger.info(`Worker stopped: ${workerId}`);
  }

  /**
   * Send a message/prompt to a running worker.
   */
  sendMessage(workerId: string, message: string): void {
    const worker = queries.getWorker.get(workerId) as Worker | undefined;
    if (!worker) throw new Error(`Worker not found: ${workerId}`);
    if (worker.status !== "running") throw new Error(`Worker is not running (status: ${worker.status})`);

    const project = this.projectManager.get(worker.project_id);
    if (!project) throw new Error(`Project not found`);

    const tmuxSession = `farm-${project.name}`;
    // Send keys to the tmux session
    execSync(`tmux send-keys -t "${tmuxSession}" "${message.replace(/"/g, '\\"')}" Enter`, {
      stdio: "pipe",
    });

    queries.addEvent.run(worker.project_id, workerId, "message_sent", message.slice(0, 200));
    logger.info(`Message sent to worker ${workerId}: ${message.slice(0, 100)}...`);
  }

  /**
   * Get output from a running worker's tmux session.
   */
  getOutput(workerId: string, lines = 50): string {
    const worker = queries.getWorker.get(workerId) as Worker | undefined;
    if (!worker) throw new Error(`Worker not found: ${workerId}`);

    const project = this.projectManager.get(worker.project_id);
    if (!project) return "(no project)";

    const tmuxSession = `farm-${project.name}`;
    try {
      return execSync(
        `tmux capture-pane -t "${tmuxSession}" -p -S -${lines}`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch {
      return "(session not available)";
    }
  }

  listActive(): Worker[] {
    return queries.listActiveWorkers.all() as Worker[];
  }

  getForProject(projectId: string): Worker | undefined {
    return queries.getActiveWorkerForProject.get(projectId) as Worker | undefined;
  }

  /**
   * Update the PROJECT_BRIEF.md for a project based on worker state.
   */
  private async updateProjectBrief(worker: Worker, project: Project): Promise<void> {
    try {
      const lastOutput = worker.last_summary || this.getOutput(worker.id, 30);
      const brief = [
        `# ${project.name}`,
        ``,
        `Last active: ${new Date().toISOString()}`,
        `Branch: ${worker.branch}`,
        `Session ID: ${worker.session_id || "unknown"}`,
        `Status: Paused`,
        ``,
        `## Recent Activity (last terminal output)`,
        "```",
        lastOutput.slice(-1500),
        "```",
        ``,
        `## Resume Instructions`,
        `This project can be resumed with its full conversation history.`,
        `The session ID is preserved for continuity.`,
      ].join("\n");

      this.projectManager.updateBrief(project.id, brief);
    } catch (err) {
      logger.warn(`Failed to update project brief: ${err}`);
    }
  }

  /**
   * Clean up completed worktrees to free disk space.
   */
  cleanupWorktrees(projectPath: string): void {
    try {
      execSync("git worktree prune", { cwd: projectPath, stdio: "pipe" });
      logger.info(`Pruned worktrees for ${projectPath}`);
    } catch (err) {
      logger.warn(`Worktree cleanup failed: ${err}`);
    }
  }
}
