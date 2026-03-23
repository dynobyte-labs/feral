import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager, Project } from "../managers/project-manager.js";
import { WorkerManager, Worker } from "../managers/worker-manager.js";
import { parseIntent, isNluAvailable } from "./chat-nlu.js";

/**
 * Platform-agnostic bot controller.
 *
 * Holds all the business logic that's shared between Slack, Discord, or any
 * future chat integration: action execution, Claude Code passthrough,
 * NLU routing, auto-resume, help text, etc.
 *
 * Platform adapters (SlackBot, DiscordBot) wire their message APIs into this
 * controller so we never duplicate business logic.
 */
export class BotController {
  readonly projectManager: ProjectManager;
  readonly workerManager: WorkerManager;

  constructor(projectManager: ProjectManager, workerManager: WorkerManager) {
    this.projectManager = projectManager;
    this.workerManager = workerManager;
  }

  // ---------------------------------------------------------------------------
  // Claude Code passthrough
  // ---------------------------------------------------------------------------

  /**
   * Known Claude Code slash commands and whether they need arguments to work
   * non-interactively. Commands marked `interactive: true` open a TUI picker
   * and need an argument to skip the picker.
   */
  static readonly CC_COMMANDS: Record<string, { description: string; interactive: boolean; hint?: string }> = {
    "/model":    { description: "Switch model", interactive: true, hint: "Usage: `/model sonnet` or `/model opus` or `/model haiku`" },
    "/effort":   { description: "Set effort level", interactive: true, hint: "Usage: `/effort high` or `/effort medium` or `/effort low`" },
    "/compact":  { description: "Compact conversation to save context", interactive: false },
    "/plan":     { description: "Toggle plan mode", interactive: false },
    "/init":     { description: "Create CLAUDE.md file", interactive: false },
    "/clear":    { description: "Clear conversation history", interactive: false },
    "/cost":     { description: "Show token usage and cost", interactive: false },
    "/help":     { description: "Show Claude Code help", interactive: false },
    "/logout":   { description: "Log out of Claude Code", interactive: false },
    "/status":   { description: "Show Claude Code status", interactive: false },
    "/config":   { description: "Open config", interactive: true, hint: "This command opens an interactive menu — may not work well via chat" },
    "/plugins":  { description: "Manage plugins", interactive: true, hint: "This command opens an interactive picker — may not work well via chat" },
    "/mcp":      { description: "Manage MCP servers", interactive: true, hint: "This command opens an interactive menu — may not work well via chat" },
  };

  /**
   * Send a Claude Code slash command directly to a worker's tmux session.
   * Returns a status message.
   */
  sendCCCommand(projectId: string, command: string): string {
    const worker = this.workerManager.getForProject(projectId);
    if (!worker) return "⚠️ No active worker. Start or resume one first.";

    const parts = command.trim().split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1).join(" ");
    const fullCommand = command.trim();

    const known = BotController.CC_COMMANDS[cmdName];
    if (known) {
      if (known.interactive && !cmdArgs) {
        return `⚠️ \`${cmdName}\` is interactive and needs an argument to work via chat.\n${known.hint || ""}`;
      }
    }

    try {
      this.workerManager.sendMessage(worker.id, fullCommand);
      return `⚡ Sent \`${fullCommand}\` to worker.`;
    } catch (err) {
      return `❌ Failed to send command: ${err}`;
    }
  }

  /**
   * Get a formatted list of available Claude Code commands.
   * @param prefix How commands are invoked on this platform (e.g. "!cc " for Slack, "/" for Discord)
   */
  getCCHelpText(prefix = "!cc "): string {
    const lines = ["⚡ **Claude Code commands:**", ""];
    for (const [cmd, info] of Object.entries(BotController.CC_COMMANDS)) {
      const tag = info.interactive ? " _(needs args)_" : "";
      lines.push(`\`${prefix}${cmd.replace("/", "")}\` — ${info.description}${tag}`);
    }
    lines.push("", "Any `/slash` command Claude Code supports will be forwarded — these are just the common ones.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Action executor (shared between NLU, commands, and slash commands)
  // ---------------------------------------------------------------------------

  /**
   * Execute a feral action by name with the given parameters.
   * This is the core dispatch — NLU, Slack !commands, and Discord slash commands
   * all funnel through here.
   *
   * @param onCreateChannel Optional callback to create a platform-specific channel
   *                        for new projects. Returns the channel ID/reference.
   */
  async executeAction(
    action: string,
    params: Record<string, unknown>,
    onCreateChannel?: (projectId: string) => Promise<string | null>,
  ): Promise<string> {
    switch (action) {
      case "create_project": {
        const name = params.name as string;
        const template = (params.template as string) || "empty";
        const description = (params.description as string) || "";
        const project = await this.projectManager.create({
          name,
          template: template as any,
          description,
        });
        let channelInfo = "";
        if (onCreateChannel) {
          const ref = await onCreateChannel(project.id);
          if (ref) channelInfo = `\n> Channel: ${ref}`;
        }
        return [
          `✅ Project **${name}** created!`,
          `> Template: \`${template}\``,
          description ? `> ${description}` : "",
          channelInfo,
        ].filter(Boolean).join("\n");
      }

      case "start_worker": {
        const projectName = params.project as string;
        const branch = (params.branch as string) || "main";
        const prompt = params.prompt as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `❌ Project "${projectName}" not found`;
        const worker = await this.workerManager.spawn({
          projectId: project.id,
          prompt,
          branch,
        });
        return `🚀 Worker \`${worker.id}\` started on **${projectName}** (\`${branch}\`).`;
      }

      case "get_status": {
        const specificProject = params.project as string | undefined;
        if (specificProject) {
          const project = this.projectManager.getByName(specificProject);
          if (!project) return `❌ Project "${specificProject}" not found`;
          const worker = this.workerManager.getForProject(project.id);
          const statusEmoji = { active: "🟢", paused: "🟠", idle: "⚪", archived: "⚫" }[project.status] || "⚪";
          return [
            `${statusEmoji} **${project.name}** — ${project.status}`,
            project.description ? `> ${project.description}` : "",
            worker ? `> Worker: \`${worker.id}\` on \`${worker.branch}\` (${worker.message_count} msgs)` : "> No active worker",
            project.repo_url ? `> Repo: ${project.repo_url}` : "",
          ].filter(Boolean).join("\n");
        }

        const projects = this.projectManager.list();
        const activeWorkers = this.workerManager.listActive();
        if (projects.length === 0) return "No projects yet. Tell me to create one!";
        const lines = projects.map((p) => {
          const worker = activeWorkers.find((w) => w.project_id === p.id);
          const emoji = { active: "🟢", paused: "🟠", idle: "⚪", archived: "⚫" }[p.status] || "⚪";
          const workerInfo = worker ? ` — \`${worker.branch}\` (${worker.message_count} msgs)` : "";
          return `${emoji} **${p.name}** [${p.status}]${workerInfo}`;
        });
        return [`📊 **Projects** (${activeWorkers.length}/${config.maxWorkers} workers active)`, "", ...lines].join("\n");
      }

      case "pause_worker": {
        const projectName = params.project as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `❌ Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) {
          const stoppable = this.workerManager.getStoppableWorkerForProject(project.id);
          if (stoppable?.status === "paused") return `⏸️ **${projectName}** is already paused. Use resume to start it back up.`;
          return `⚠️ No active worker for ${projectName}`;
        }
        await this.workerManager.pause(worker.id);
        return `⏸️ **${projectName}** paused. Just say "resume" when you're ready.`;
      }

      case "resume_worker": {
        const projectName = params.project as string;
        const instructions = params.instructions as string | undefined;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `❌ Project "${projectName}" not found`;
        const worker = await this.workerManager.resume(project.id, instructions);
        return `▶️ **${projectName}** resumed (worker \`${worker.id}\`).`;
      }

      case "stop_worker": {
        const projectName = params.project as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `❌ Project "${projectName}" not found`;
        const worker = this.workerManager.getStoppableWorkerForProject(project.id);
        if (!worker) {
          if (project.status !== "idle") {
            this.projectManager.setStatus(project.id, "idle");
            return `⏹️ **${projectName}** reset to idle (worker was already gone).`;
          }
          return `⚪ **${projectName}** is already idle.`;
        }
        await this.workerManager.stop(worker.id);
        return `⏹️ **${projectName}** stopped.`;
      }

      case "send_message": {
        const projectName = params.project as string;
        const message = params.message as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `❌ Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) return `⚠️ No active worker for ${projectName}. Start or resume one first.`;
        this.workerManager.sendMessage(worker.id, message);
        return `💬 Sent to **${projectName}**`;
      }

      case "get_logs": {
        const projectName = params.project as string;
        const lines = (params.lines as number) || 30;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `❌ Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) return `⚠️ No active worker for ${projectName}`;
        const output = this.workerManager.getOutput(worker.id, lines);
        return "```\n" + output.slice(-3000) + "\n```";
      }

      case "cleanup": {
        const projects = this.projectManager.list();
        let cleaned = 0;
        for (const p of projects) {
          try { this.workerManager.cleanupWorktrees(p.path); cleaned++; } catch { /* ignore */ }
        }
        return `🧹 Cleaned up worktrees for ${cleaned} projects.`;
      }

      case "show_help": {
        return this.getHelpText();
      }

      case "open_dashboard": {
        return this.getDashboardText(params.project as string | undefined);
      }

      default:
        return `🤔 I understood the action "${action}" but I don't know how to do that yet.`;
    }
  }

  // ---------------------------------------------------------------------------
  // NLU / mention handling
  // ---------------------------------------------------------------------------

  /**
   * Handle a natural language message — parse intent via NLU and execute.
   * Returns the response text, or null if nothing to say (e.g. random chatter
   * with no intent detected).
   */
  async handleNaturalLanguage(
    text: string,
    onCreateChannel?: (projectId: string) => Promise<string | null>,
  ): Promise<string | null> {
    // Quick keyword matching
    if (/^help$/i.test(text)) return this.getHelpText();
    if (/^status$/i.test(text)) return this.executeAction("get_status", {}, onCreateChannel);

    if (!isNluAvailable()) {
      return "I heard you, but natural language mode needs an ANTHROPIC_API_KEY. Try the help command for available commands.";
    }

    try {
      const projects = this.projectManager.list();
      const activeWorkers = this.workerManager.listActive();
      const stateContext = `${projects.length} projects (${activeWorkers.length} active workers): ${projects.map(p => `${p.name} [${p.status}]`).join(", ") || "none"}`;

      const nlu = await parseIntent(text, { stateContext });

      if (nlu.action) {
        const result = await this.executeAction(nlu.action, nlu.params, onCreateChannel);
        return nlu.reply ? `${nlu.reply}\n\n${result}` : result;
      } else if (nlu.reply) {
        return nlu.reply;
      }
      return null;
    } catch (err) {
      logger.error(`NLU error: ${err}`);
      return "❌ Sorry, I had trouble understanding that. Try the help command.";
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-resume routing
  // ---------------------------------------------------------------------------

  /**
   * Route a message to a project's worker, auto-resuming if dead.
   * Returns a status message if there's something to tell the user (e.g.
   * "auto-resuming..."), or null if the message was sent silently.
   */
  async routeToWorker(
    projectId: string,
    text: string,
  ): Promise<{ status: "sent" | "resuming" | "waiting" | "error"; message?: string; worker?: Worker }> {
    let worker = this.workerManager.getForProject(projectId);

    // No active worker — auto-resume
    if (!worker) {
      const project = this.projectManager.get(projectId);
      if (!project) return { status: "error", message: "Project not found." };

      try {
        worker = await this.workerManager.resume(projectId, text);
        return {
          status: "resuming",
          message: `🔄 Worker for **${project.name}** wasn't running — auto-resuming with your message... (~15s)`,
          worker,
        };
      } catch (err) {
        return { status: "error", message: `❌ Auto-resume failed: ${err}` };
      }
    }

    // Still starting — wait
    if (worker.status === "starting") {
      const maxWait = 20;
      for (let i = 0; i < maxWait; i++) {
        await new Promise(r => setTimeout(r, 1000));
        worker = this.workerManager.getForProject(projectId);
        if (!worker || worker.status !== "starting") break;
      }
      if (!worker || worker.status === "starting") {
        return { status: "waiting", message: "⏳ Worker is still starting up — try again in a few seconds." };
      }
      if (worker.status !== "running") {
        return { status: "error", message: `⚠️ Worker failed to start (status: ${worker.status}). Check logs.` };
      }
    }

    // Send the message
    try {
      this.workerManager.sendMessage(worker.id, text);
      return { status: "sent", worker };
    } catch (err) {
      return { status: "error", message: `❌ Failed to send to worker: ${err}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Help text
  // ---------------------------------------------------------------------------

  /**
   * Generic help text. Platform adapters can override or augment this.
   */
  getHelpText(): string {
    return [
      "👋 **I'm Feral** — I manage Claude Code workers on your dedicated machine.",
      "",
      "**Talk to me:**",
      "Just @mention me or type in a project channel — messages go straight to the worker.",
      "",
      "**Management commands:**",
      "Create, start, pause, resume, stop workers, check status, view logs.",
      "",
      "**Claude Code commands:**",
      "Switch model, set effort, compact context, toggle plan mode, check cost, and more.",
      "",
      "Use your platform's help command for the full list.",
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Dashboard link
  // ---------------------------------------------------------------------------

  /**
   * Build a dashboard link message, optionally deep-linking to a specific
   * project's terminal.
   */
  getDashboardText(projectName?: string): string {
    const base = config.dashboard.url;
    const lines = [`🖥️ **Feral Dashboard:** ${base}`];

    if (projectName) {
      lines.push(`⌨️ **Terminal:** ${base}/terminal?project=${encodeURIComponent(projectName)}`);
    }

    if (base.includes("localhost")) {
      lines.push(
        "",
        "_Tip: Set `DASHBOARD_URL` in .env to your Tailscale address (e.g. `http://mac-mini.tail1234.ts.net:3000`) so these links work from anywhere. No password needed — Tailscale handles access._",
      );
    }

    return lines.filter(Boolean).join("\n");
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  /** Resolve a project from its name */
  resolveProject(name: string): Project | undefined {
    return this.projectManager.getByName(name);
  }

  /** Get project name from its ID */
  projectNameFromId(projectId: string): string | undefined {
    return this.projectManager.get(projectId)?.name;
  }
}
