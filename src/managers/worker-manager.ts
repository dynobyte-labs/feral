import { randomUUID } from "crypto";
import { execSync, exec } from "child_process";
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
  private projectManager: ProjectManager;

  /** Tracks last seen tmux output per worker to detect new content */
  private lastOutput: Map<string, string> = new Map();
  /** Accumulates new output per worker for debounced delivery */
  private pendingOutput: Map<string, string> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(projectManager: ProjectManager) {
    this.projectManager = projectManager;
  }

  // ---------------------------------------------------------------------------
  // Tmux helpers
  // ---------------------------------------------------------------------------

  /** Check if a tmux session exists */
  private tmuxSessionExists(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Capture pane content from a tmux session */
  private tmuxCapture(sessionName: string, lines = 200): string {
    try {
      return execSync(
        `tmux capture-pane -t "${sessionName}" -p -S -${lines}`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch {
      return "";
    }
  }

  /**
   * Send text to a tmux session safely.
   * Uses tmux's literal flag to avoid shell interpretation issues.
   */
  private tmuxSendText(sessionName: string, text: string): void {
    // Write the message to a temp file and use load-buffer + paste-buffer
    // to avoid ALL shell escaping issues with send-keys
    const tmpFile = path.join(config.paths.data, `tmux-msg-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpFile, text);
      execSync(`tmux load-buffer "${tmpFile}" \\; paste-buffer -t "${sessionName}" -d`, {
        stdio: "pipe",
      });
      // Send Enter to submit
      execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: "pipe" });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * Wait for the tmux pane to show signs that Claude is ready for input.
   * Returns true if ready, false if timed out.
   *
   * Claude Code v2.1+ uses ❯ as its input prompt character.
   * The status bar "bypass permissions on" also indicates readiness.
   */
  private async waitForReady(sessionName: string, timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    const interval = 500;

    while (Date.now() - start < timeoutMs) {
      const pane = this.tmuxCapture(sessionName, 30);
      if (/❯/.test(pane) || /bypass permissions on/i.test(pane)) {
        return true;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Output polling
  // ---------------------------------------------------------------------------

  /**
   * Strip Claude Code TUI chrome from captured pane content.
   * Removes status bars, box-drawing decorations, thinking indicators,
   * spinners, tool-use headers, and other non-content lines so only
   * meaningful Claude output is forwarded to Slack.
   */
  private stripTuiChrome(text: string): string {
    return text
      .split("\n")
      .filter(line => {
        const trimmed = line.trim();
        // Skip empty lines
        if (!trimmed) return false;
        // Skip status bar lines (bottom of TUI)
        if (/⏵⏵|bypass permissions|shift\+tab|esc to interrupt/i.test(trimmed)) return false;
        // Skip lines that are only box-drawing / decoration
        if (/^[╭╰╮╯│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬\s─═▌▐▛▜▝▘]+$/.test(trimmed)) return false;
        // Skip the bare prompt character
        if (/^❯\s*$/.test(trimmed)) return false;
        // Skip effort/mode indicators
        if (/^◐|medium\s*·\s*\/effort|·\s*\/effort/i.test(trimmed)) return false;
        // Skip thinking/spinner indicators
        if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●◉◌⣾⣽⣻⢿⡿⣟⣯⣷⠀⠁⠂⠃⠄⠅⠆⠇]\s*(thinking|processing|working)/i.test(trimmed)) return false;
        // Skip bare spinner characters (braille animation frames)
        if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s*$/.test(trimmed)) return false;
        // Skip "Thinking..." or "◌ Thinking" lines
        if (/^[◌●◉]?\s*(Thinking|Processing|Working)\.*$/i.test(trimmed)) return false;
        // Skip tool use header decorations ("── Read ──", "── Bash ──", etc.)
        if (/^─+\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|TodoWrite|Search)\s*─+$/i.test(trimmed)) return false;
        // Skip welcome banner content
        if (/Welcome back|Tips for getting started|Run \/init|Recent activity|No recent activity|Opus.*context|Claude Max|now defaults to/i.test(trimmed)) return false;
        // Skip version/session info
        if (/^Claude Code v[\d.]+|pmseltmann@gmail\.com/i.test(trimmed)) return false;
        // Skip project path display
        if (/^~\/projects\//i.test(trimmed)) return false;
        return true;
      })
      .join("\n")
      .trim();
  }

  /**
   * Start polling active workers for new output.
   *
   * Uses a two-stage approach to avoid Slack message spam:
   * 1. POLL (every pollIntervalMs): capture tmux, diff against last, accumulate new content
   * 2. FLUSH (every flushIntervalMs): deliver accumulated content to the callback
   *
   * This means while Claude is actively working (thinking, running tools, writing code),
   * output accumulates and gets delivered as one batch instead of many small messages.
   */
  startOutputPolling(
    onOutput: (projectId: string, text: string) => void,
    pollIntervalMs = 2000,
    flushIntervalMs = 8000
  ): void {
    if (this.pollInterval) return;

    // Stage 1: Poll tmux and accumulate new content
    this.pollInterval = setInterval(() => {
      const activeWorkers = this.listActive();
      for (const worker of activeWorkers) {
        try {
          const project = this.projectManager.get(worker.project_id);
          if (!project) continue;

          const tmuxSession = `feral-${project.name}`;
          if (!this.tmuxSessionExists(tmuxSession)) continue;

          const rawCapture = this.tmuxCapture(tmuxSession);
          if (!rawCapture) continue;

          const lastRaw = this.lastOutput.get(worker.id) ?? "";
          if (rawCapture === lastRaw) continue;

          const currentClean = this.stripTuiChrome(rawCapture);
          const lastClean = this.stripTuiChrome(lastRaw);

          this.lastOutput.set(worker.id, rawCapture);

          if (currentClean !== lastClean && currentClean.length > 0) {
            const newContent = currentClean.length > lastClean.length
              ? currentClean.slice(lastClean.length).trim()
              : currentClean.trim();

            if (newContent.length > 0) {
              // Accumulate instead of sending immediately
              const existing = this.pendingOutput.get(worker.project_id) ?? "";
              this.pendingOutput.set(
                worker.project_id,
                existing ? `${existing}\n${newContent}` : newContent
              );
            }
          }
        } catch (err) {
          logger.debug(`Output poll error for worker ${worker.id}: ${err}`);
        }
      }
    }, pollIntervalMs);

    // Stage 2: Flush accumulated output to Slack
    this.flushInterval = setInterval(() => {
      for (const [projectId, text] of this.pendingOutput.entries()) {
        if (text.length > 0) {
          // Truncate very long output to avoid Slack message limits
          const truncated = text.length > 3500
            ? `...\n${text.slice(-3500)}`
            : text;
          onOutput(projectId, truncated);
        }
      }
      this.pendingOutput.clear();
    }, flushIntervalMs);

    logger.info(`Worker output polling started (poll: ${pollIntervalMs}ms, flush: ${flushIntervalMs}ms)`);
  }

  stopOutputPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.pendingOutput.clear();
  }

  // ---------------------------------------------------------------------------
  // Health checking
  // ---------------------------------------------------------------------------

  /**
   * Periodically check that active workers still have live tmux sessions.
   * Mark workers as errored if their session has disappeared.
   */
  startHealthCheck(intervalMs = 15000): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(() => {
      const activeWorkers = this.listActive();
      for (const worker of activeWorkers) {
        try {
          const project = this.projectManager.get(worker.project_id);
          if (!project) continue;

          const tmuxSession = `feral-${project.name}`;
          if (!this.tmuxSessionExists(tmuxSession)) {
            logger.warn(`Worker ${worker.id} (${project.name}): tmux session '${tmuxSession}' is gone — marking as error`);
            queries.updateWorkerStatus.run("error", worker.id);
            queries.addEvent.run(worker.project_id, worker.id, "worker_error", "tmux session disappeared unexpectedly");
            this.projectManager.setStatus(worker.project_id, "idle");
            this.lastOutput.delete(worker.id);
          }
        } catch (err) {
          logger.debug(`Health check error for worker ${worker.id}: ${err}`);
        }
      }
    }, intervalMs);

    logger.info(`Worker health check started (every ${intervalMs}ms)`);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn
  // ---------------------------------------------------------------------------

  /**
   * Spawn a new Claude Code worker for a project.
   */
  async spawn(options: SpawnWorkerOptions): Promise<Worker> {
    const { projectId, prompt, branch = "main", useWorktree = true } = options;

    const project = this.projectManager.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Verify tmux and claude CLI are available
    for (const tool of ["tmux", "claude"]) {
      try {
        execSync(`which ${tool}`, { stdio: "pipe" });
      } catch {
        const installHint = tool === "tmux"
          ? "brew install tmux (macOS) or apt install tmux (Linux)"
          : "npm install -g @anthropic-ai/claude-code";
        throw new Error(`${tool} is not installed. Install with: ${installHint}`);
      }
    }

    // Check active worker limit
    const activeWorkers = this.listActive();
    if (activeWorkers.length >= config.maxWorkers) {
      throw new Error(
        `Maximum active workers reached (${config.maxWorkers}). Pause or stop a worker first.`
      );
    }

    // Check if project already has an active worker
    const existing = queries.getActiveWorkerForProject.get(projectId) as Worker | undefined;
    if (existing) {
      throw new Error(
        `Project "${project.name}" already has an active worker (${existing.id}). Stop it first or resume it.`
      );
    }

    const workerId = `worker-${Date.now()}`;
    const sessionName = `${project.name}-${branch}`;
    let worktreePath = project.path;

    // Create git worktree if using a non-main branch
    if (useWorktree && branch !== "main") {
      worktreePath = path.join(config.projectsDir, ".worktrees", `${project.name}-${branch}`);
      try {
        execSync(
          `git worktree add "${worktreePath}" -b "${branch}" 2>/dev/null || git worktree add "${worktreePath}" "${branch}"`,
          { cwd: project.path, stdio: "pipe" }
        );
        logger.info(`Created worktree: ${worktreePath} on branch ${branch}`);
      } catch (err) {
        logger.warn(`Worktree creation failed, using main path: ${err}`);
        worktreePath = project.path;
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

    // Save worker record (status = 'starting')
    queries.createWorker.run(workerId, projectId, null, sessionName, branch, worktreePath);
    this.projectManager.setStatus(projectId, "active");

    const tmuxSession = `feral-${project.name}`;

    try {
      // Step 1: Run the startup script to launch Claude and handle all prompts
      const startScript = path.resolve("scripts/start-worker.sh");
      logger.info(`Spawning worker ${workerId} for ${project.name} — running startup script...`);

      try {
        const { stdout, stderr } = await execAsync(
          `bash "${startScript}" "${tmuxSession}" "${worktreePath}"`,
          {
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: config.anthropicApiKey,
              PATH: process.env.PATH,
              HOME: process.env.HOME,
            },
            timeout: 45000, // Give it more time — Claude can be slow to start
          }
        );
        if (stdout) logger.debug(`start-worker.sh stdout: ${stdout.trim()}`);
        if (stderr) logger.debug(`start-worker.sh stderr: ${stderr.trim()}`);
      } catch (scriptErr: any) {
        // Check exit code — our script uses specific codes
        const exitCode = scriptErr.code;
        if (exitCode === 2 || exitCode === 3) {
          // Session genuinely failed to start
          throw new Error(`Startup script failed (exit ${exitCode}): ${scriptErr.stderr || scriptErr.message}`);
        }
        // For other non-zero exits, check if the session is actually alive
        if (this.tmuxSessionExists(tmuxSession)) {
          logger.warn(`Startup script exited with code ${exitCode} but tmux session exists — continuing`);
        } else {
          throw new Error(`Worker failed to start: ${scriptErr.message}`);
        }
      }

      // Step 2: Verify the tmux session is alive
      if (!this.tmuxSessionExists(tmuxSession)) {
        throw new Error(`tmux session '${tmuxSession}' does not exist after startup script completed`);
      }

      // Step 3: Brief wait for Claude to settle, then check readiness
      const ready = await this.waitForReady(tmuxSession, 5000);
      if (!ready) {
        logger.warn(`Claude readiness check timed out for ${tmuxSession}, but session exists — sending prompt anyway`);
      }

      // Step 4: Set up a monitoring window (optional, non-blocking)
      this.setupMonitorWindow(tmuxSession, project.name);

      // Step 5: Send the initial prompt using the safe method
      logger.info(`Sending initial prompt to ${tmuxSession} (${fullPrompt.length} chars)`);
      this.tmuxSendText(tmuxSession, fullPrompt);

      // Step 6: Mark as running
      queries.updateWorkerStatus.run("running", workerId);
      queries.addEvent.run(projectId, workerId, "worker_started", `Worker started on branch ${branch}`);
      logger.info(`Worker spawned: ${workerId} for ${project.name} on ${branch}`, { tmuxSession });

    } catch (err) {
      queries.updateWorkerStatus.run("error", workerId);
      queries.addEvent.run(projectId, workerId, "worker_error", `Failed to spawn: ${err}`);
      // Try to clean up the tmux session if it's lingering
      try { execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`); } catch { /* ignore */ }
      throw err;
    }

    return queries.getWorker.get(workerId) as Worker;
  }

  /** Create a monitoring window in feral-monitor for a worker (best-effort) */
  private setupMonitorWindow(tmuxSession: string, projectName: string): void {
    try {
      const monitorSession = "feral-monitor";
      try {
        execSync(`tmux new-session -d -s "${monitorSession}" 2>/dev/null`, { stdio: "pipe" });
      } catch { /* already exists */ }
      execSync(
        `tmux new-window -t "${monitorSession}" -n "${projectName}" "tmux attach -t ${tmuxSession}"`,
        { stdio: "pipe" }
      );
      logger.debug(`Monitor window created for ${projectName}`);
    } catch { /* monitoring is optional */ }
  }

  // ---------------------------------------------------------------------------
  // Pause / Resume / Stop
  // ---------------------------------------------------------------------------

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
    if (this.tmuxSessionExists(tmuxSession)) {
      try {
        const output = this.tmuxCapture(tmuxSession, 50);
        queries.updateWorkerSummary.run(output.slice(-2000), worker.message_count, workerId);
      } catch { /* best effort */ }
    }

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

    // Reset project status if it's stuck (e.g. previous worker errored out)
    const existingWorker = queries.getActiveWorkerForProject.get(projectId) as Worker | undefined;
    if (existingWorker) {
      logger.warn(`Project ${project.name} has stale active worker ${existingWorker.id} (status: ${existingWorker.status}) — cleaning up`);
      queries.updateWorkerStatus.run("stopped", existingWorker.id);
    }

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

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

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
    if (!this.tmuxSessionExists(tmuxSession)) {
      // Session is gone — mark as errored
      queries.updateWorkerStatus.run("error", workerId);
      this.projectManager.setStatus(worker.project_id, "idle");
      throw new Error(`Worker session '${tmuxSession}' no longer exists. Worker has been marked as errored.`);
    }

    // Use the safe send method (temp file + paste buffer) to avoid escaping issues
    this.tmuxSendText(tmuxSession, message);

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
    const output = this.tmuxCapture(tmuxSession, lines);
    return output || "(session not available)";
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  listActive(): Worker[] {
    return queries.listActiveWorkers.all() as Worker[];
  }

  listAll(): Worker[] {
    return queries.listAllWorkers.all() as Worker[];
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

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
