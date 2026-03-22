import { randomUUID } from "crypto";
import { execSync, spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import { config } from "../config.js";
import { queries } from "../db/database.js";
import { logger } from "../logger.js";
import { ProjectManager, Project } from "./project-manager.js";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

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

  /** Tracks last seen tmux output per worker to detect new content */
  private lastOutput: Map<string, string> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(projectManager: ProjectManager) {
    this.projectManager = projectManager;
  }

  /**
   * Start polling active workers for new output.
   * Calls onOutput(projectId, newText) whenever a worker produces new content.
   * Call this once after the bot starts.
   */
  startOutputPolling(onOutput: (projectId: string, text: string) => void, intervalMs = 3000): void {
    if (this.pollInterval) return; // already running

    this.pollInterval = setInterval(() => {
      const activeWorkers = this.listActive();
      for (const worker of activeWorkers) {
        try {
          const project = this.projectManager.get(worker.project_id);
          if (!project) continue;

          const tmuxSession = `feral-${project.name}`;
          let current: string;
          try {
            current = execSync(
              `tmux capture-pane -t "${tmuxSession}" -p -S -200`,
              { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
            );
          } catch {
            continue; // session not available yet
          }

          const last = this.lastOutput.get(worker.id) ?? "";

          if (current !== last) {
            // Find what's new — everything after the last known content
            const newContent = current.length > last.length
              ? current.slice(last.length).trim()
              : current.trim(); // full refresh if shorter (screen cleared)

            if (newContent.length > 0) {
              this.lastOutput.set(worker.id, current);
              onOutput(worker.project_id, newContent);
            } else {
              this.lastOutput.set(worker.id, current);
            }
          }
        } catch (err) {
          logger.debug(`Output poll error for worker ${worker.id}: ${err}`);
        }
      }
    }, intervalMs);

    logger.info(`Worker output polling started (every ${intervalMs}ms)`);
  }

  stopOutputPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Spawn a new Claude Code worker for a project.
   */
  async spawn(options: SpawnWorkerOptions): Promise<Worker> {
    const { projectId, prompt, branch = "main", useWorktree = true } = options;

    const project = this.projectManager.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Verify tmux and claude CLI are available
    try {
      execSync("which tmux", { stdio: "pipe" });
    } catch {
      throw new Error(
        "tmux is not installed. Install it with: brew install tmux (macOS) or apt install tmux (Linux)"
      );
    }
    try {
      execSync("which claude", { stdio: "pipe" });
    } catch {
      throw new Error(
        "Claude Code CLI is not installed. Install it with: npm install -g @anthropic-ai/claude-code"
      );
    }

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

    // In interactive mode, claude maintains its own session history.
    // No --resume flag needed — we inject the project brief into the prompt instead.
    const resumeFlag = "";

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
    // Run claude in interactive mode (no -p flag) so the session stays alive
    // and we can keep sending messages to it via tmux send-keys.
    const tmuxSession = `feral-${project.name}`;
    const claudeCmd = [
      "claude",
      "--dangerously-skip-permissions",
      resumeFlag,
    ].filter(Boolean).join(" ");

    try {
      // Use the startup script to launch claude and auto-accept all startup prompts.
      // Uses async exec so the event loop stays alive (keeps Slack WS heartbeats going).
      const startScript = path.resolve("scripts/start-worker.sh");
      await execAsync(`bash "${startScript}" "${tmuxSession}" "${worktreePath}"`, {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.anthropicApiKey,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        timeout: 25000, // 25s max for startup
      });

      // Create a monitoring window in the feral main tmux session (if running in tmux)
      // This lets you watch worker activity with: tmux attach -t feral-monitor
      try {
        const monitorSession = "feral-monitor";
        // Create monitor session if it doesn't exist
        try {
          execSync(`tmux new-session -d -s "${monitorSession}" 2>/dev/null`, { stdio: "pipe" });
        } catch { /* already exists */ }
        // Open a new window watching this worker
        execSync(
          `tmux new-window -t "${monitorSession}" -n "${project.name}" "tmux attach -t ${tmuxSession}"`,
          { stdio: "pipe" }
        );
        logger.info(`Monitor window created: tmux attach -t ${monitorSession}`);
      } catch { /* monitoring is optional, don't fail spawn */ }

      // Send the initial prompt
      const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");
      execSync(`tmux send-keys -t "${tmuxSession}" '${escapedPrompt}' Enter`, {
        stdio: "pipe",
      });

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

    const tmuxSession = `feral-${project.name}`;

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
    this.lastOutput.delete(workerId);
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
    const tmuxSession = project ? `feral-${project.name}` : null;

    if (tmuxSession) {
      try { execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`); } catch { /* ignore */ }
    }

    if (project) {
      await this.updateProjectBrief(worker, project);
    }

    queries.stopWorker.run(workerId);
    this.lastOutput.delete(workerId);
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

    const tmuxSession = `feral-${project.name}`;
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

    const tmuxSession = `feral-${project.name}`;
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

  /** Get any stoppable worker for a project — running, starting, or paused. */
  getStoppableWorkerForProject(projectId: string): Worker | undefined {
    const worker = queries.getLastWorkerForProject.get(projectId) as Worker | undefined;
    if (!worker) return undefined;
    if (["starting", "running", "paused"].includes(worker.status)) return worker;
    return undefined;
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
