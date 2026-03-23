import { App as SlackApp } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";
import { parseIntent, isNluAvailable } from "./chat-nlu.js";

/**
 * Slack bot with three interaction modes:
 * 1. @mention the bot — works anywhere, triggers NLU or command parsing
 * 2. !commands — explicit fallback, always available
 * 3. Project channel messages — routed directly to the Claude Code worker
 *
 * Also supports !cc for passing Claude Code internal commands (/model, /compact, etc.)
 * directly to the worker's tmux session.
 */
export class SlackBot {
  private app: SlackApp | null = null;
  private client: WebClient | null = null;
  private projectManager: ProjectManager;
  private workerManager: WorkerManager;
  private botUserId: string | null = null;

  /** Maps Slack channel IDs to project IDs for routing */
  private channelToProject: Map<string, string> = new Map();
  /** Tracks the "live output" message per project channel so we can edit instead of re-post */
  private liveMessages: Map<string, { ts: string; text: string }> = new Map();

  constructor(projectManager: ProjectManager, workerManager: WorkerManager) {
    this.projectManager = projectManager;
    this.workerManager = workerManager;
  }

  async start(): Promise<void> {
    if (!config.slack.enabled) {
      logger.info("Slack bot disabled (no SLACK_BOT_TOKEN)");
      return;
    }

    this.app = new SlackApp({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      socketMode: true,
    });

    this.client = new WebClient(config.slack.botToken);

    // Get the bot's own user ID so we can detect @mentions
    try {
      const auth = await this.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info(`Bot user ID: ${this.botUserId}`);
    } catch (err) {
      logger.warn(`Could not get bot user ID: ${err}`);
    }

    // Load existing channel mappings from database
    for (const project of this.projectManager.list()) {
      if (project.slack_channel_id) {
        this.channelToProject.set(project.slack_channel_id, project.id);
      }
    }

    // Register handlers
    this.registerCommands();
    this.registerMessageHandler();

    await this.app.start();

    // Start polling worker output and forwarding it to project channels.
    // isFinal=true means Claude finished responding (prompt returned) —
    // post as a new message instead of editing the live one.
    this.workerManager.startOutputPolling(async (projectId, text, isFinal) => {
      if (isFinal) {
        // Claude is done — post as a brand-new message so the response
        // stands on its own, then clear the live message tracker.
        this.clearLiveMessage(projectId);
        await this.postToProject(projectId, "```\n" + text.slice(-3000) + "\n```");
      } else {
        await this.postLiveOutput(projectId, text);
      }
    });

    const mode = isNluAvailable() ? "natural language + commands" : "commands only (set ANTHROPIC_API_KEY for natural language)";
    logger.info(`Slack bot started (socket mode, ${mode})`);
  }

  // ---------------------------------------------------------------------------
  // @mention handling
  // ---------------------------------------------------------------------------

  /**
   * Check if a message is an @mention of the bot.
   * Returns the message text with the @mention stripped, or null if not a mention.
   */
  private extractMention(text: string): string | null {
    if (!this.botUserId) return null;
    const mentionPattern = new RegExp(`<@${this.botUserId}>\\s*`, "gi");
    if (!mentionPattern.test(text)) return null;
    // Reset lastIndex after test()
    mentionPattern.lastIndex = 0;
    return text.replace(mentionPattern, "").trim();
  }

  // ---------------------------------------------------------------------------
  // Channel management
  // ---------------------------------------------------------------------------

  /**
   * Create a Slack channel for a project and wire it up.
   */
  async createProjectChannel(projectId: string): Promise<string | null> {
    if (!this.client) return null;

    const project = this.projectManager.get(projectId);
    if (!project) return null;

    try {
      const safeName = `proj-${project.name}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);

      const result = await this.client.conversations.create({
        name: safeName,
        is_private: false,
      });

      const channelId = result.channel?.id;
      if (!channelId) throw new Error("No channel ID returned");

      // Auto-invite the owner
      if (config.slack.ownerId) {
        try {
          await this.client.conversations.invite({
            channel: channelId,
            users: config.slack.ownerId,
          });
        } catch (inviteErr) {
          logger.warn(`Could not invite owner to channel: ${inviteErr}`);
        }
      }

      // Set topic
      await this.client.conversations.setTopic({
        channel: channelId,
        topic: [
          project.description || project.name,
          project.repo_url ? `| ${project.repo_url}` : "",
        ].filter(Boolean).join(" "),
      });

      // Post intro message
      await this.client.chat.postMessage({
        channel: channelId,
        text: [
          `:rocket: *Project ${project.name}* initialized.`,
          project.repo_url ? `Repo: ${project.repo_url}` : "",
          `Template: \`${project.template}\``,
          "",
          "Messages you type here go straight to the Claude Code worker.",
          "",
          "*Worker management:* `!start` `!pause` `!resume` `!stop` `!status` `!logs`",
          "*Claude Code commands:* `!cc /model sonnet` `!cc /compact` `!cc /plan` etc.",
          "",
          "Or just @mention me anywhere for natural language control.",
        ].filter(Boolean).join("\n"),
      });

      // Wire up
      this.channelToProject.set(channelId, projectId);
      this.projectManager.setSlackChannel(projectId, channelId);

      logger.info(`Slack channel created: #proj-${project.name} (${channelId})`);
      return channelId;
    } catch (err) {
      logger.error(`Failed to create Slack channel: ${err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Slack messaging
  // ---------------------------------------------------------------------------

  /**
   * Post a message to a project's Slack channel.
   */
  async postToProject(projectId: string, text: string): Promise<void> {
    if (!this.client) return;
    const project = this.projectManager.get(projectId);
    if (!project?.slack_channel_id) return;

    try {
      await this.client.chat.postMessage({
        channel: project.slack_channel_id,
        text,
      });
    } catch (err) {
      logger.warn(`Failed to post to Slack: ${err}`);
    }
  }

  /**
   * Post or update a "live output" message for a project.
   * Edits a single message instead of posting new ones while Claude works.
   */
  async postLiveOutput(projectId: string, text: string): Promise<void> {
    if (!this.client) return;
    const project = this.projectManager.get(projectId);
    if (!project?.slack_channel_id) return;
    const channelId = project.slack_channel_id;

    const formatted = "```\n" + text.slice(-3000) + "\n```";

    try {
      const existing = this.liveMessages.get(projectId);

      if (existing) {
        const combined = existing.text + "\n" + text;
        const truncated = combined.length > 3000
          ? "..." + combined.slice(-3000)
          : combined;
        const updatedFormatted = "```\n" + truncated + "\n```";

        try {
          await this.client.chat.update({
            channel: channelId,
            ts: existing.ts,
            text: updatedFormatted,
          });
          this.liveMessages.set(projectId, { ts: existing.ts, text: truncated });
          return;
        } catch (updateErr) {
          logger.debug(`Could not update live message, posting new: ${updateErr}`);
          this.liveMessages.delete(projectId);
        }
      }

      const result = await this.client.chat.postMessage({
        channel: channelId,
        text: formatted,
      });

      if (result.ts) {
        this.liveMessages.set(projectId, { ts: result.ts, text });
      }
    } catch (err) {
      logger.warn(`Failed to post live output to Slack: ${err}`);
    }
  }

  clearLiveMessage(projectId: string): void {
    this.liveMessages.delete(projectId);
  }

  // ---------------------------------------------------------------------------
  // NLU action executor
  // ---------------------------------------------------------------------------

  private async executeAction(
    action: string,
    params: Record<string, unknown>
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
        const channelId = await this.createProjectChannel(project.id);
        return [
          `:white_check_mark: Project *${name}* created!`,
          `> Template: \`${template}\``,
          description ? `> ${description}` : "",
          channelId ? `> Channel: <#${channelId}>` : "",
        ].filter(Boolean).join("\n");
      }

      case "start_worker": {
        const projectName = params.project as string;
        const branch = (params.branch as string) || "main";
        const prompt = params.prompt as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = await this.workerManager.spawn({
          projectId: project.id,
          prompt,
          branch,
        });
        return `:rocket: Worker \`${worker.id}\` started on *${projectName}* (\`${branch}\`).`;
      }

      case "get_status": {
        const specificProject = params.project as string | undefined;
        if (specificProject) {
          const project = this.projectManager.getByName(specificProject);
          if (!project) return `:x: Project "${specificProject}" not found`;
          const worker = this.workerManager.getForProject(project.id);
          const statusEmoji = { active: ":large_green_circle:", paused: ":large_orange_circle:", idle: ":white_circle:", archived: ":black_circle:" }[project.status] || ":white_circle:";
          return [
            `${statusEmoji} *${project.name}* — ${project.status}`,
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
          const emoji = { active: ":large_green_circle:", paused: ":large_orange_circle:", idle: ":white_circle:", archived: ":black_circle:" }[p.status] || ":white_circle:";
          const workerInfo = worker ? ` — \`${worker.branch}\` (${worker.message_count} msgs)` : "";
          return `${emoji} *${p.name}* [${p.status}]${workerInfo}`;
        });
        return [`:bar_chart: *Projects* (${activeWorkers.length}/${config.maxWorkers} workers active)`, "", ...lines].join("\n");
      }

      case "pause_worker": {
        const projectName = params.project as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) {
          const stoppable = this.workerManager.getStoppableWorkerForProject(project.id);
          if (stoppable?.status === "paused") return `:pause_button: *${projectName}* is already paused. Use \`!resume\` to start it back up.`;
          return `:warning: No active worker for ${projectName}`;
        }
        await this.workerManager.pause(worker.id);
        this.clearLiveMessage(project.id);
        return `:pause_button: *${projectName}* paused. Just say "resume" when you're ready.`;
      }

      case "resume_worker": {
        const projectName = params.project as string;
        const instructions = params.instructions as string | undefined;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = await this.workerManager.resume(project.id, instructions);
        return `:arrow_forward: *${projectName}* resumed (worker \`${worker.id}\`).`;
      }

      case "stop_worker": {
        const projectName = params.project as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = this.workerManager.getStoppableWorkerForProject(project.id);
        if (!worker) {
          if (project.status !== "idle") {
            this.projectManager.setStatus(project.id, "idle");
            return `:stop_button: *${projectName}* reset to idle (worker was already gone).`;
          }
          return `:white_circle: *${projectName}* is already idle.`;
        }
        await this.workerManager.stop(worker.id);
        this.clearLiveMessage(project.id);
        return `:stop_button: *${projectName}* stopped.`;
      }

      case "send_message": {
        const projectName = params.project as string;
        const message = params.message as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) return `:warning: No active worker for ${projectName}. Start or resume one first.`;
        this.clearLiveMessage(project.id);
        this.workerManager.sendMessage(worker.id, message);
        return `:speech_balloon: Sent to *${projectName}*`;
      }

      case "get_logs": {
        const projectName = params.project as string;
        const lines = (params.lines as number) || 30;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) return `:warning: No active worker for ${projectName}`;
        const output = this.workerManager.getOutput(worker.id, lines);
        return "```\n" + output.slice(-3000) + "\n```";
      }

      case "cleanup": {
        const projects = this.projectManager.list();
        let cleaned = 0;
        for (const p of projects) {
          try { this.workerManager.cleanupWorktrees(p.path); cleaned++; } catch { /* ignore */ }
        }
        return `:broom: Cleaned up worktrees for ${cleaned} projects.`;
      }

      case "show_help": {
        return this.getHelpText();
      }

      default:
        return `:thinking_face: I understood the action "${action}" but I don't know how to do that yet.`;
    }
  }

  // ---------------------------------------------------------------------------
  // Claude Code passthrough
  // ---------------------------------------------------------------------------

  /**
   * Known Claude Code slash commands and whether they need arguments to work
   * non-interactively. Commands marked `interactive: true` open a TUI picker
   * and need an argument to skip the picker.
   */
  private static readonly CC_COMMANDS: Record<string, { description: string; interactive: boolean; hint?: string }> = {
    "/model":    { description: "Switch model", interactive: true, hint: "Usage: `!cc /model sonnet` or `!cc /model opus` or `!cc /model haiku`" },
    "/effort":   { description: "Set effort level", interactive: true, hint: "Usage: `!cc /effort high` or `!cc /effort medium` or `!cc /effort low`" },
    "/compact":  { description: "Compact conversation to save context", interactive: false },
    "/plan":     { description: "Toggle plan mode", interactive: false },
    "/init":     { description: "Create CLAUDE.md file", interactive: false },
    "/clear":    { description: "Clear conversation history", interactive: false },
    "/cost":     { description: "Show token usage and cost", interactive: false },
    "/help":     { description: "Show Claude Code help", interactive: false },
    "/logout":   { description: "Log out of Claude Code", interactive: false },
    "/status":   { description: "Show Claude Code status", interactive: false },
    "/config":   { description: "Open config", interactive: true, hint: "This command opens an interactive menu — may not work well via Slack" },
    "/plugins":  { description: "Manage plugins", interactive: true, hint: "This command opens an interactive picker — may not work well via Slack" },
    "/mcp":      { description: "Manage MCP servers", interactive: true, hint: "This command opens an interactive menu — may not work well via Slack" },
  };

  /**
   * Send a Claude Code slash command directly to a worker's tmux session.
   * Returns a status message for Slack.
   */
  private sendCCCommand(projectId: string, command: string): string {
    const worker = this.workerManager.getForProject(projectId);
    if (!worker) return `:warning: No active worker. Start or resume one first.`;

    // Parse the command name and arguments
    const parts = command.trim().split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1).join(" ");
    const fullCommand = command.trim();

    // Check if it's a known command
    const known = SlackBot.CC_COMMANDS[cmdName];
    if (known) {
      // Warn about interactive commands that need arguments
      if (known.interactive && !cmdArgs) {
        return `:warning: \`${cmdName}\` is interactive and needs an argument to work via Slack.\n${known.hint || ""}`;
      }
    }

    // Send it — clear live message first so the response starts fresh
    try {
      const project = this.projectManager.get(projectId);
      if (project) this.clearLiveMessage(project.id);
      this.workerManager.sendMessage(worker.id, fullCommand);
      return `:zap: Sent \`${fullCommand}\` to worker.`;
    } catch (err) {
      return `:x: Failed to send command: ${err}`;
    }
  }

  /**
   * Get a formatted list of available Claude Code commands.
   */
  private getCCHelpText(): string {
    const lines = [":zap: *Claude Code commands* (use with `!cc`):", ""];
    for (const [cmd, info] of Object.entries(SlackBot.CC_COMMANDS)) {
      const tag = info.interactive ? " _(needs args)_" : "";
      lines.push(`\`!cc ${cmd}\` — ${info.description}${tag}`);
    }
    lines.push("", "Any `/slash` command Claude Code supports will be forwarded — these are just the common ones.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Help text
  // ---------------------------------------------------------------------------

  private getHelpText(): string {
    const mentionText = this.botUserId ? `<@${this.botUserId}>` : "@Feral";
    return [
      ":wave: *I'm Feral* — I manage Claude Code workers on your dedicated machine.",
      "",
      ":speech_balloon: *Talk to me:*",
      `Just @mention me: ${mentionText} _create a project called my-app_`,
      `Or in a project channel, type directly — it goes straight to the worker.`,
      "",
      ":hammer_and_wrench: *Management commands:*",
      "`!new <name> [desc]` — Create a project",
      "`!start [project] [prompt]` — Start a worker",
      "`!status` — Overview of all projects",
      "`!pause [project]` — Pause a worker",
      "`!resume [project] [instructions]` — Resume",
      "`!stop [project]` — Stop permanently",
      "`!tell <project> <msg>` — Send a message to a worker",
      "`!logs [project] [lines]` — View output",
      "`!cleanup` — Clean up worktrees",
      "",
      ":zap: *Claude Code commands:*",
      "`!cc /model sonnet` — Switch model",
      "`!cc /effort high` — Set effort level",
      "`!cc /compact` — Compact context",
      "`!cc /plan` — Toggle plan mode",
      "`!cc /cost` — Show token usage",
      "`!cc /clear` — Clear conversation",
      "`!cc /help` — List all CC commands",
      "",
      "_In project channels, project name is auto-detected — just use `!pause`, `!logs`, etc._",
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Command registration (! commands)
  // ---------------------------------------------------------------------------

  private registerCommands(): void {
    if (!this.app) return;

    // !cc <slash-command> — Claude Code passthrough
    this.app.message(/^!cc\s+(.+)$/is, async ({ say, message, context }) => {
      const [, command] = context.matches!;
      const projectId = this.channelToProject.get(message.channel);

      if (!projectId) {
        // Not in a project channel — need to figure out which project
        await say(`:x: Use \`!cc\` from a project channel so I know which worker to send to.`);
        return;
      }

      if (command.trim().toLowerCase() === "help") {
        await say(this.getCCHelpText());
        return;
      }

      const result = this.sendCCCommand(projectId, command.trim());
      await say(result);
    });

    // !new <name> [description]
    this.app.message(/^!new\s+(\S+)\s*(.*)$/i, async ({ say, context }) => {
      const [, name, description] = context.matches!;
      await say(`:hammer_and_wrench: Creating project *${name}*...`);
      this.executeAction("create_project", {
        name, template: "empty", description: description?.trim() || "",
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    // !start [project] [prompt]
    this.app.message(/^!start(?:\s+(\S+))?\s*(.*)$/is, async ({ say, message, context }) => {
      const [, nameArg, prompt] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:rocket: Starting worker for *${projectName}*... (this takes ~15s)`);
      this.executeAction("start_worker", {
        project: projectName,
        branch: "main",
        prompt: prompt?.trim() || "Check the PROJECT_BRIEF.md and start working.",
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!status$/i, async ({ say }) => {
      this.executeAction("get_status", {})
        .then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!pause(?:\s+(\S+))?$/i, async ({ say, message, context }) => {
      const [, nameArg] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:hourglass: Pausing *${projectName}*...`);
      this.executeAction("pause_worker", { project: projectName })
        .then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!resume(?:\s+(\S+))?\s*(.*)$/is, async ({ say, message, context }) => {
      const [, nameArg, instructions] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:arrow_forward: Resuming *${projectName}*... (this takes ~15s)`);
      this.executeAction("resume_worker", {
        project: projectName, instructions: instructions?.trim() || undefined,
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!stop(?:\s+(\S+))?$/i, async ({ say, message, context }) => {
      const [, nameArg] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:hourglass: Stopping *${projectName}*...`);
      this.executeAction("stop_worker", { project: projectName })
        .then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!logs(?:\s+(\S+))?\s*(\d+)?$/i, async ({ say, message, context }) => {
      const [, nameArg, lineCount] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      this.executeAction("get_logs", {
        project: projectName, lines: parseInt(lineCount || "30"),
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!tell\s+(\S+)\s+(.+)$/is, async ({ say, context }) => {
      const [, projectName, message] = context.matches!;
      try {
        const result = await this.executeAction("send_message", {
          project: projectName, message,
        });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!cleanup$/i, async ({ say }) => {
      try {
        const result = await this.executeAction("cleanup", {});
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!help$/i, async ({ say }) => {
      await say(this.getHelpText());
    });
  }

  // ---------------------------------------------------------------------------
  // Main message handler — @mentions, NLU, project channel routing
  // ---------------------------------------------------------------------------

  private registerMessageHandler(): void {
    if (!this.app) return;

    this.app.message(async ({ message, say }) => {
      if (!("text" in message) || !message.text) return;
      if (message.text.startsWith("!")) return; // Handled by command handlers

      // Skip bot messages to avoid loops
      if ("bot_id" in message && message.bot_id) return;

      const rawText = message.text.trim();
      const projectId = this.channelToProject.get(message.channel);

      // Check if this is an @mention
      const mentionedText = this.extractMention(rawText);
      const isMention = mentionedText !== null;
      const text = mentionedText ?? rawText;

      // --- @mention from anywhere: process as a management command ---
      if (isMention) {
        await this.handleMentionOrNLU(text, message.channel, say);
        return;
      }

      // --- Project channel (not a mention): route to worker ---
      if (projectId) {
        this.routeToWorker(projectId, text, say);
        return;
      }

      // --- Non-project channel, not a mention: NLU if available ---
      // Only respond if NLU detects an intent (don't respond to random chatter)
      if (isNluAvailable()) {
        await this.handleMentionOrNLU(text, message.channel, say);
      }
    });
  }

  /**
   * Handle a message that's either an @mention or general-channel NLU.
   * Uses NLU to parse intent, or falls back to basic keyword matching.
   */
  private async handleMentionOrNLU(
    text: string,
    channel: string,
    say: (msg: string) => Promise<unknown>
  ): Promise<void> {
    // Quick keyword matching for common requests (no NLU needed)
    if (/^help$/i.test(text)) {
      await say(this.getHelpText());
      return;
    }
    if (/^status$/i.test(text)) {
      const result = await this.executeAction("get_status", {});
      await say(result);
      return;
    }

    // Try NLU for natural language
    if (isNluAvailable()) {
      try {
        const projects = this.projectManager.list();
        const activeWorkers = this.workerManager.listActive();
        const stateContext = `${projects.length} projects (${activeWorkers.length} active workers): ${projects.map(p => `${p.name} [${p.status}]`).join(", ") || "none"}`;

        const nlu = await parseIntent(text, { stateContext });

        if (nlu.action) {
          try {
            const result = await this.executeAction(nlu.action, nlu.params);
            const response = nlu.reply ? `${nlu.reply}\n\n${result}` : result;
            await say(response);
          } catch (err) {
            await say(`:x: ${err}`);
          }
        } else if (nlu.reply) {
          await say(nlu.reply);
        }
      } catch (err) {
        logger.error(`NLU error: ${err}`);
        await say(`:x: Sorry, I had trouble understanding that. Try \`!help\` for commands.`);
      }
    } else {
      // No NLU available — tell the user to use commands
      await say(`I heard you, but natural language mode needs an ANTHROPIC_API_KEY. Try \`!help\` for available commands.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private projectNameFromChannel(channelId: string): string | undefined {
    const projectId = this.channelToProject.get(channelId);
    if (!projectId) return undefined;
    return this.projectManager.get(projectId)?.name;
  }

  /**
   * Direct routing: send message to a project's active worker.
   * If the worker is dead/stopped/errored, auto-resumes it.
   * If the worker is still starting up, waits briefly for it to become ready.
   */
  private async routeToWorker(
    projectId: string,
    text: string,
    say: (msg: string) => Promise<unknown>
  ): Promise<void> {
    let worker = this.workerManager.getForProject(projectId);

    // No active worker — try to auto-resume
    if (!worker) {
      const project = this.projectManager.get(projectId);
      if (!project) {
        await say(":warning: Project not found.");
        return;
      }

      await say(`:arrows_counterclockwise: Worker for *${project.name}* isn't running — auto-resuming... (this takes ~15s)`);
      try {
        worker = await this.workerManager.resume(projectId, text);
        // Worker started with the user's message as the prompt, so we're done
        return;
      } catch (err) {
        await say(`:x: Auto-resume failed: ${err}`);
        return;
      }
    }

    // If worker is still starting, wait up to 20s for it to become "running"
    if (worker.status === "starting") {
      const maxWait = 20;
      for (let i = 0; i < maxWait; i++) {
        await new Promise(r => setTimeout(r, 1000));
        worker = this.workerManager.getForProject(projectId);
        if (!worker || worker.status !== "starting") break;
      }
      if (!worker || worker.status === "starting") {
        await say(":hourglass: Worker is still starting up — try again in a few seconds.");
        return;
      }
      if (worker.status !== "running") {
        await say(`:warning: Worker failed to start (status: ${worker.status}). Check logs.`);
        return;
      }
    }

    // Clear the live message so Claude's response starts as a new message
    this.clearLiveMessage(projectId);

    try {
      this.workerManager.sendMessage(worker.id, text);
    } catch (err) {
      await say(`:x: Failed to send to worker: ${err}`);
    }
  }
}
