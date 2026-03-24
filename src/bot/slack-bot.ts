import { App as SlackApp } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";
import { isNluAvailable } from "./chat-nlu.js";
import { BotController } from "./bot-controller.js";

/**
 * Slack adapter for Feral.
 *
 * Handles all Slack-specific concerns: Bolt message handlers, channel creation,
 * live message editing, @mention detection, !commands.
 *
 * Business logic (action execution, NLU, CC passthrough, auto-resume) lives
 * in BotController and is shared with the Discord adapter.
 */
export class SlackBot {
  private app: SlackApp | null = null;
  private client: WebClient | null = null;
  private ctrl: BotController;
  private botUserId: string | null = null;

  /** Maps Slack channel IDs to project IDs for routing */
  private channelToProject: Map<string, string> = new Map();
  /** Tracks the "live output" message per project channel so we can edit instead of re-post */
  private liveMessages: Map<string, { ts: string; text: string }> = new Map();

  constructor(projectManager: ProjectManager, workerManager: WorkerManager) {
    this.ctrl = new BotController(projectManager, workerManager);
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
      logger.info(`Slack bot user ID: ${this.botUserId}`);
    } catch (err) {
      logger.warn(`Could not get bot user ID: ${err}`);
    }

    // Load existing channel mappings from database
    for (const project of this.ctrl.projectManager.list()) {
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
    this.ctrl.workerManager.startOutputPolling(async (projectId, text, isFinal) => {
      if (isFinal) {
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

  private extractMention(text: string): string | null {
    if (!this.botUserId) return null;
    const mentionPattern = new RegExp(`<@${this.botUserId}>\\s*`, "gi");
    if (!mentionPattern.test(text)) return null;
    mentionPattern.lastIndex = 0;
    return text.replace(mentionPattern, "").trim();
  }

  // ---------------------------------------------------------------------------
  // Channel management
  // ---------------------------------------------------------------------------

  async createProjectChannel(projectId: string): Promise<string | null> {
    if (!this.client) return null;

    const project = this.ctrl.projectManager.get(projectId);
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

      await this.client.conversations.setTopic({
        channel: channelId,
        topic: [
          project.description || project.name,
          project.repo_url ? `| ${project.repo_url}` : "",
        ].filter(Boolean).join(" "),
      });

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

      this.channelToProject.set(channelId, projectId);
      this.ctrl.projectManager.setSlackChannel(projectId, channelId);

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

  async postToProject(projectId: string, text: string): Promise<void> {
    if (!this.client) return;
    const project = this.ctrl.projectManager.get(projectId);
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

  async postLiveOutput(projectId: string, text: string): Promise<void> {
    if (!this.client) return;
    const project = this.ctrl.projectManager.get(projectId);
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
  // Slack-flavored help text
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
      "`!dashboard` — Open the web dashboard",
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
    const createChannel = (pid: string) => this.createProjectChannel(pid).then(id => id ? `<#${id}>` : null);

    // !cc <slash-command> — Claude Code passthrough
    this.app.message(/^!cc\s+(.+)$/is, async ({ say, message, context }) => {
      const [, command] = context.matches!;
      const projectId = this.channelToProject.get(message.channel);

      if (!projectId) {
        await say(`:x: Use \`!cc\` from a project channel so I know which worker to send to.`);
        return;
      }

      if (command.trim().toLowerCase() === "help") {
        await say(this.ctrl.getCCHelpText("!cc "));
        return;
      }

      this.clearLiveMessage(projectId);
      const result = this.ctrl.sendCCCommand(projectId, command.trim());
      await say(result);
    });

    // !new <name> [description]
    this.app.message(/^!new\s+(\S+)\s*(.*)$/i, async ({ say, context }) => {
      const [, name, description] = context.matches!;
      await say(`:hammer_and_wrench: Creating project *${name}*...`);
      this.ctrl.executeAction("create_project", {
        name, template: "empty", description: description?.trim() || "",
      }, createChannel).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    // !start [project] [prompt]
    this.app.message(/^!start(?:\s+(\S+))?\s*(.*)$/is, async ({ say, message, context }) => {
      const [, nameArg, prompt] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:rocket: Starting worker for *${projectName}*... (this takes ~15s)`);
      this.ctrl.executeAction("start_worker", {
        project: projectName, branch: "main",
        prompt: prompt?.trim() || "Check the PROJECT_BRIEF.md and start working.",
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!status$/i, async ({ say }) => {
      this.ctrl.executeAction("get_status", {})
        .then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!pause(?:\s+(\S+))?$/i, async ({ say, message, context }) => {
      const [, nameArg] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:hourglass: Pausing *${projectName}*...`);
      this.ctrl.executeAction("pause_worker", { project: projectName })
        .then(result => { this.clearLiveMessage(this.projectIdFromChannel(message.channel) || ""); say(result); })
        .catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!resume(?:\s+(\S+))?\s*(.*)$/is, async ({ say, message, context }) => {
      const [, nameArg, instructions] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:arrow_forward: Resuming *${projectName}*... (this takes ~15s)`);
      this.ctrl.executeAction("resume_worker", {
        project: projectName, instructions: instructions?.trim() || undefined,
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!stop(?:\s+(\S+))?$/i, async ({ say, message, context }) => {
      const [, nameArg] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      await say(`:hourglass: Stopping *${projectName}*...`);
      this.ctrl.executeAction("stop_worker", { project: projectName })
        .then(result => { this.clearLiveMessage(this.projectIdFromChannel(message.channel) || ""); say(result); })
        .catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!logs(?:\s+(\S+))?\s*(\d+)?$/i, async ({ say, message, context }) => {
      const [, nameArg, lineCount] = context.matches!;
      const projectName = nameArg?.trim() || this.projectNameFromChannel(message.channel);
      if (!projectName) { await say(`:x: Specify a project name or run this from a project channel.`); return; }
      this.ctrl.executeAction("get_logs", {
        project: projectName, lines: parseInt(lineCount || "30"),
      }).then(result => say(result)).catch(err => say(`:x: ${err}`));
    });

    this.app.message(/^!tell\s+(\S+)\s+(.+)$/is, async ({ say, context }) => {
      const [, projectName, message] = context.matches!;
      try {
        const result = await this.ctrl.executeAction("send_message", {
          project: projectName, message,
        });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!cleanup$/i, async ({ say }) => {
      try {
        const result = await this.ctrl.executeAction("cleanup", {});
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!dashboard$/i, async ({ say, message }) => {
      const projectName = this.projectNameFromChannel(message.channel);
      const result = this.ctrl.getDashboardText(projectName);
      await say(result);
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
    const createChannel = (pid: string) => this.createProjectChannel(pid).then(id => id ? `<#${id}>` : null);

    this.app.message(async ({ message, say }) => {
      if (!("text" in message) || !message.text) return;
      if (message.text.startsWith("!")) return;
      if ("bot_id" in message && message.bot_id) return;

      const rawText = message.text.trim();
      const projectId = this.channelToProject.get(message.channel);

      const mentionedText = this.extractMention(rawText);
      const isMention = mentionedText !== null;
      const text = mentionedText ?? rawText;

      // @mention from anywhere: NLU
      if (isMention) {
        const response = await this.ctrl.handleNaturalLanguage(text, createChannel, message.channel);
        if (response) await say(response);
        return;
      }

      // Project channel: route to worker
      if (projectId) {
        this.clearLiveMessage(projectId);
        const result = await this.ctrl.routeToWorker(projectId, text);
        if (result.message) await say(result.message);
        return;
      }

      // Non-project channel, not a mention: NLU if available
      if (isNluAvailable()) {
        const response = await this.ctrl.handleNaturalLanguage(text, createChannel, message.channel);
        if (response) await say(response);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private projectNameFromChannel(channelId: string): string | undefined {
    const projectId = this.channelToProject.get(channelId);
    if (!projectId) return undefined;
    return this.ctrl.projectManager.get(projectId)?.name;
  }

  private projectIdFromChannel(channelId: string): string | undefined {
    return this.channelToProject.get(channelId);
  }
}
