/**
 * Discord adapter for Feral.
 *
 * Uses native slash commands for Claude Code passthrough (/model, /compact, etc.)
 * and management (/start, /pause, /status, etc.). Worker output is posted into
 * threads per-worker so the main channel stays clean.
 *
 * discord.js is an optional dependency — this module gracefully fails if it's
 * not installed.
 */

import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";
import { BotController } from "./bot-controller.js";

// Dynamic import types — discord.js is optional
type Discord = typeof import("discord.js");
type Client = import("discord.js").Client;
type TextChannel = import("discord.js").TextChannel;
type ChatInputCommandInteraction = import("discord.js").ChatInputCommandInteraction;
type Message = import("discord.js").Message;

export class DiscordBot {
  private client: Client | null = null;
  private ctrl: BotController;
  private discord: Discord | null = null;

  /** Maps Discord channel IDs to project IDs for routing */
  private channelToProject: Map<string, string> = new Map();
  /** Maps project IDs to an active output thread ID (keeps main channel clean) */
  private projectThreads: Map<string, string> = new Map();
  /** Live message being edited per project (within a thread) */
  private liveMessages: Map<string, { id: string; text: string }> = new Map();

  constructor(projectManager: ProjectManager, workerManager: WorkerManager) {
    this.ctrl = new BotController(projectManager, workerManager);
  }

  async start(): Promise<void> {
    if (!config.discord.enabled) {
      logger.info("Discord bot disabled (no DISCORD_BOT_TOKEN)");
      return;
    }

    // Dynamic import — discord.js is optional
    try {
      this.discord = await import("discord.js");
    } catch {
      logger.warn("discord.js not installed — run `npm install discord.js` to enable Discord support");
      return;
    }

    const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, Partials } = this.discord;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    // Register slash commands
    await this.registerSlashCommands();

    // Load existing channel mappings
    for (const project of this.ctrl.projectManager.list()) {
      if (project.discord_channel_id) {
        this.channelToProject.set(project.discord_channel_id, project.id);
      }
    }

    // Handle slash commands
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await this.handleSlashCommand(interaction as ChatInputCommandInteraction);
      } catch (err) {
        logger.error(`Discord slash command error: ${err}`);
        const reply = interaction.replied || interaction.deferred
          ? interaction.followUp.bind(interaction)
          : interaction.reply.bind(interaction);
        try { await reply({ content: `❌ ${err}`, ephemeral: true }); } catch { /* ignore */ }
      }
    });

    // Handle regular messages in project channels (route to worker)
    this.client.on("messageCreate", async (message: Message) => {
      if (message.author.bot) return;
      if (!message.guild) return;

      const projectId = this.channelToProject.get(message.channelId);
      if (!projectId) return;

      // Messages in project channels go straight to the worker
      const text = message.content.trim();
      if (!text) return;

      this.clearLiveMessage(projectId);
      const result = await this.ctrl.routeToWorker(projectId, text);
      if (result.message) {
        await message.reply(result.message);
      }
    });

    this.client.once("ready", (c) => {
      logger.info(`Discord bot logged in as ${c.user.tag}`);
    });

    await this.client.login(config.discord.botToken);

    // Start output polling — post into threads
    this.ctrl.workerManager.startOutputPolling(async (projectId, text, isFinal) => {
      if (isFinal) {
        this.clearLiveMessage(projectId);
        await this.postToProjectThread(projectId, "```\n" + text.slice(-1800) + "\n```");
      } else {
        await this.postLiveOutput(projectId, text);
      }
    });

    logger.info("Discord bot started");
  }

  // ---------------------------------------------------------------------------
  // Slash command registration
  // ---------------------------------------------------------------------------

  private async registerSlashCommands(): Promise<void> {
    if (!this.discord || !config.discord.botToken) return;
    const { REST, Routes, SlashCommandBuilder } = this.discord;

    const commands = [
      // -- Management commands --
      new SlashCommandBuilder()
        .setName("feral")
        .setDescription("Feral management commands")
        .addSubcommand(sub =>
          sub.setName("new")
            .setDescription("Create a new project")
            .addStringOption(o => o.setName("name").setDescription("Project name").setRequired(true))
            .addStringOption(o => o.setName("template").setDescription("Template")
              .addChoices(
                { name: "Empty", value: "empty" },
                { name: "Web (Next.js)", value: "web" },
                { name: "API (Express)", value: "api" },
                { name: "iOS", value: "ios" },
                { name: "Fullstack (monorepo)", value: "fullstack" },
              ))
            .addStringOption(o => o.setName("description").setDescription("Short description")),
        )
        .addSubcommand(sub =>
          sub.setName("start")
            .setDescription("Start a worker for a project")
            .addStringOption(o => o.setName("project").setDescription("Project name (auto-detected in project channels)"))
            .addStringOption(o => o.setName("prompt").setDescription("Instructions for the worker")),
        )
        .addSubcommand(sub =>
          sub.setName("status")
            .setDescription("Show status of all projects")
            .addStringOption(o => o.setName("project").setDescription("Specific project")),
        )
        .addSubcommand(sub =>
          sub.setName("pause")
            .setDescription("Pause a running worker")
            .addStringOption(o => o.setName("project").setDescription("Project name")),
        )
        .addSubcommand(sub =>
          sub.setName("resume")
            .setDescription("Resume a paused worker")
            .addStringOption(o => o.setName("project").setDescription("Project name"))
            .addStringOption(o => o.setName("instructions").setDescription("Additional instructions")),
        )
        .addSubcommand(sub =>
          sub.setName("stop")
            .setDescription("Stop a worker permanently")
            .addStringOption(o => o.setName("project").setDescription("Project name")),
        )
        .addSubcommand(sub =>
          sub.setName("tell")
            .setDescription("Send a message to a worker")
            .addStringOption(o => o.setName("project").setDescription("Project name").setRequired(true))
            .addStringOption(o => o.setName("message").setDescription("Message to send").setRequired(true)),
        )
        .addSubcommand(sub =>
          sub.setName("logs")
            .setDescription("View recent worker output")
            .addStringOption(o => o.setName("project").setDescription("Project name"))
            .addIntegerOption(o => o.setName("lines").setDescription("Number of lines").setMinValue(5).setMaxValue(100)),
        )
        .addSubcommand(sub =>
          sub.setName("cleanup")
            .setDescription("Clean up worktrees to free disk space"),
        )
        .addSubcommand(sub =>
          sub.setName("dashboard")
            .setDescription("Get link to the web dashboard and terminal"),
        )
        .addSubcommand(sub =>
          sub.setName("help")
            .setDescription("Show help"),
        ),

      // -- Claude Code passthrough commands (native slash commands!) --
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Switch Claude Code model")
        .addStringOption(o => o.setName("model").setDescription("Model to use").setRequired(true)
          .addChoices(
            { name: "Sonnet", value: "sonnet" },
            { name: "Opus", value: "opus" },
            { name: "Haiku", value: "haiku" },
          )),

      new SlashCommandBuilder()
        .setName("effort")
        .setDescription("Set Claude Code effort level")
        .addStringOption(o => o.setName("level").setDescription("Effort level").setRequired(true)
          .addChoices(
            { name: "High", value: "high" },
            { name: "Medium", value: "medium" },
            { name: "Low", value: "low" },
          )),

      new SlashCommandBuilder()
        .setName("compact")
        .setDescription("Compact Claude Code conversation to save context"),

      new SlashCommandBuilder()
        .setName("plan")
        .setDescription("Toggle Claude Code plan mode"),

      new SlashCommandBuilder()
        .setName("cost")
        .setDescription("Show Claude Code token usage and cost"),

      new SlashCommandBuilder()
        .setName("cc")
        .setDescription("Send any Claude Code slash command")
        .addStringOption(o => o.setName("command").setDescription("The slash command (e.g. /clear, /init)").setRequired(true)),
    ];

    const rest = new REST().setToken(config.discord.botToken!);

    try {
      if (config.discord.guildId) {
        // Guild-specific (instant update, good for dev)
        await rest.put(
          Routes.applicationGuildCommands(
            (await rest.get(Routes.currentApplication()) as any).id,
            config.discord.guildId,
          ),
          { body: commands.map(c => c.toJSON()) },
        );
        logger.info(`Discord slash commands registered (guild: ${config.discord.guildId})`);
      } else {
        // Global (can take up to an hour to propagate)
        const appId = ((await rest.get(Routes.currentApplication())) as any).id;
        await rest.put(Routes.applicationCommands(appId), {
          body: commands.map(c => c.toJSON()),
        });
        logger.info("Discord slash commands registered (global — may take up to 1 hour to propagate)");
      }
    } catch (err) {
      logger.error(`Failed to register Discord slash commands: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Slash command handler
  // ---------------------------------------------------------------------------

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const projectIdFromChannel = this.channelToProject.get(interaction.channelId);
    const createChannel = (pid: string) => this.createProjectChannel(pid, interaction);

    // Resolve project name — from option, channel, or error
    const resolveProject = (option?: string): string | undefined => {
      if (option) return option;
      if (projectIdFromChannel) return this.ctrl.projectNameFromId(projectIdFromChannel);
      return undefined;
    };

    const cmdName = interaction.commandName;

    // -- Claude Code passthrough commands --
    if (cmdName === "model") {
      if (!projectIdFromChannel) {
        await interaction.reply({ content: "❌ Use this from a project channel.", ephemeral: true });
        return;
      }
      const model = interaction.options.getString("model", true);
      this.clearLiveMessage(projectIdFromChannel);
      const result = this.ctrl.sendCCCommand(projectIdFromChannel, `/model ${model}`);
      await interaction.reply(result);
      return;
    }

    if (cmdName === "effort") {
      if (!projectIdFromChannel) {
        await interaction.reply({ content: "❌ Use this from a project channel.", ephemeral: true });
        return;
      }
      const level = interaction.options.getString("level", true);
      this.clearLiveMessage(projectIdFromChannel);
      const result = this.ctrl.sendCCCommand(projectIdFromChannel, `/effort ${level}`);
      await interaction.reply(result);
      return;
    }

    if (cmdName === "compact" || cmdName === "plan" || cmdName === "cost") {
      if (!projectIdFromChannel) {
        await interaction.reply({ content: "❌ Use this from a project channel.", ephemeral: true });
        return;
      }
      this.clearLiveMessage(projectIdFromChannel);
      const result = this.ctrl.sendCCCommand(projectIdFromChannel, `/${cmdName}`);
      await interaction.reply(result);
      return;
    }

    if (cmdName === "cc") {
      if (!projectIdFromChannel) {
        await interaction.reply({ content: "❌ Use this from a project channel.", ephemeral: true });
        return;
      }
      let command = interaction.options.getString("command", true).trim();
      if (!command.startsWith("/")) command = "/" + command;
      this.clearLiveMessage(projectIdFromChannel);
      const result = this.ctrl.sendCCCommand(projectIdFromChannel, command);
      await interaction.reply(result);
      return;
    }

    // -- Management commands (under /feral) --
    if (cmdName !== "feral") return;
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case "new": {
        const name = interaction.options.getString("name", true);
        const template = interaction.options.getString("template") || "empty";
        const description = interaction.options.getString("description") || "";
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("create_project", { name, template, description }, createChannel);
        await interaction.editReply(result);
        break;
      }

      case "start": {
        const projectName = resolveProject(interaction.options.getString("project") || undefined);
        if (!projectName) { await interaction.reply({ content: "❌ Specify a project or use this in a project channel.", ephemeral: true }); return; }
        const prompt = interaction.options.getString("prompt") || "Check the PROJECT_BRIEF.md and start working.";
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("start_worker", { project: projectName, branch: "main", prompt });
        await interaction.editReply(result);
        break;
      }

      case "status": {
        const projectName = interaction.options.getString("project") || undefined;
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("get_status", { project: projectName });
        await interaction.editReply(result);
        break;
      }

      case "pause": {
        const projectName = resolveProject(interaction.options.getString("project") || undefined);
        if (!projectName) { await interaction.reply({ content: "❌ Specify a project.", ephemeral: true }); return; }
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("pause_worker", { project: projectName });
        if (projectIdFromChannel) this.clearLiveMessage(projectIdFromChannel);
        await interaction.editReply(result);
        break;
      }

      case "resume": {
        const projectName = resolveProject(interaction.options.getString("project") || undefined);
        if (!projectName) { await interaction.reply({ content: "❌ Specify a project.", ephemeral: true }); return; }
        const instructions = interaction.options.getString("instructions") || undefined;
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("resume_worker", { project: projectName, instructions });
        await interaction.editReply(result);
        break;
      }

      case "stop": {
        const projectName = resolveProject(interaction.options.getString("project") || undefined);
        if (!projectName) { await interaction.reply({ content: "❌ Specify a project.", ephemeral: true }); return; }
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("stop_worker", { project: projectName });
        if (projectIdFromChannel) this.clearLiveMessage(projectIdFromChannel);
        await interaction.editReply(result);
        break;
      }

      case "tell": {
        const projectName = interaction.options.getString("project", true);
        const message = interaction.options.getString("message", true);
        const result = await this.ctrl.executeAction("send_message", { project: projectName, message });
        await interaction.reply(result);
        break;
      }

      case "logs": {
        const projectName = resolveProject(interaction.options.getString("project") || undefined);
        if (!projectName) { await interaction.reply({ content: "❌ Specify a project.", ephemeral: true }); return; }
        const lines = interaction.options.getInteger("lines") || 30;
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("get_logs", { project: projectName, lines });
        // Discord limit is 2000 chars
        await interaction.editReply(result.slice(0, 2000));
        break;
      }

      case "cleanup": {
        await interaction.deferReply();
        const result = await this.ctrl.executeAction("cleanup", {});
        await interaction.editReply(result);
        break;
      }

      case "dashboard": {
        const projectName = resolveProject(undefined);
        const result = this.ctrl.getDashboardText(projectName);
        await interaction.reply(result);
        break;
      }

      case "help": {
        await interaction.reply(this.getHelpText());
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Channel management
  // ---------------------------------------------------------------------------

  async createProjectChannel(
    projectId: string,
    interaction?: ChatInputCommandInteraction,
  ): Promise<string | null> {
    if (!this.client || !this.discord) return null;
    const { ChannelType } = this.discord;

    const project = this.ctrl.projectManager.get(projectId);
    if (!project) return null;

    // Use the guild from the interaction or fallback to config
    const guildId = interaction?.guildId || config.discord.guildId;
    if (!guildId) return null;

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;

    try {
      const safeName = `proj-${project.name}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 100);

      const channel = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        topic: [
          project.description || project.name,
          project.repo_url ? `| ${project.repo_url}` : "",
        ].filter(Boolean).join(" "),
      });

      // Post intro message
      await channel.send([
        `🚀 **Project ${project.name}** initialized.`,
        project.repo_url ? `Repo: ${project.repo_url}` : "",
        `Template: \`${project.template}\``,
        "",
        "Messages you type here go straight to the Claude Code worker.",
        "",
        "**Slash commands:** `/feral start`, `/feral pause`, `/feral status`, `/feral logs`",
        "**Claude Code:** `/model sonnet`, `/effort high`, `/compact`, `/plan`, `/cost`",
        "**Or just type** — your messages route directly to the worker.",
      ].filter(Boolean).join("\n"));

      this.channelToProject.set(channel.id, projectId);
      this.ctrl.projectManager.setDiscordChannel(projectId, channel.id);

      logger.info(`Discord channel created: #${safeName} (${channel.id})`);
      return `<#${channel.id}>`;
    } catch (err) {
      logger.error(`Failed to create Discord channel: ${err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Thread-based output
  // ---------------------------------------------------------------------------

  /**
   * Get or create the output thread for a project in its Discord channel.
   */
  private async getOutputThread(projectId: string): Promise<TextChannel | null> {
    if (!this.client || !this.discord) return null;

    const project = this.ctrl.projectManager.get(projectId);
    if (!project?.discord_channel_id) return null;

    const channel = this.client.channels.cache.get(project.discord_channel_id) as TextChannel | undefined;
    if (!channel) return null;

    // Check for existing thread
    const existingThreadId = this.projectThreads.get(projectId);
    if (existingThreadId) {
      const thread = channel.threads.cache.get(existingThreadId);
      if (thread && !thread.archived) return thread as any;
      this.projectThreads.delete(projectId);
    }

    // Create new thread
    try {
      const worker = this.ctrl.workerManager.getForProject(projectId);
      const threadName = `output-${new Date().toISOString().slice(0, 16).replace("T", "-")}`;
      const thread = await channel.threads.create({
        name: threadName,
        reason: `Worker output for ${project.name}`,
      });
      this.projectThreads.set(projectId, thread.id);
      return thread as any;
    } catch (err) {
      logger.debug(`Could not create output thread: ${err}`);
      return channel; // Fallback to main channel
    }
  }

  async postToProjectThread(projectId: string, text: string): Promise<void> {
    const channel = await this.getOutputThread(projectId);
    if (!channel) return;

    try {
      // Discord 2000 char limit
      await channel.send(text.slice(0, 2000));
    } catch (err) {
      logger.warn(`Failed to post to Discord: ${err}`);
    }
  }

  async postLiveOutput(projectId: string, text: string): Promise<void> {
    const channel = await this.getOutputThread(projectId);
    if (!channel) return;

    const formatted = "```\n" + text.slice(-1800) + "\n```";

    try {
      const existing = this.liveMessages.get(projectId);

      if (existing) {
        const combined = existing.text + "\n" + text;
        const truncated = combined.length > 1800
          ? "..." + combined.slice(-1800)
          : combined;
        const updatedFormatted = "```\n" + truncated + "\n```";

        try {
          const msg = await channel.messages.fetch(existing.id);
          await msg.edit(updatedFormatted);
          this.liveMessages.set(projectId, { id: existing.id, text: truncated });
          return;
        } catch {
          this.liveMessages.delete(projectId);
        }
      }

      const msg = await channel.send(formatted);
      this.liveMessages.set(projectId, { id: msg.id, text });
    } catch (err) {
      logger.warn(`Failed to post live output to Discord: ${err}`);
    }
  }

  clearLiveMessage(projectId: string): void {
    this.liveMessages.delete(projectId);
  }

  // ---------------------------------------------------------------------------
  // Help text (Discord-flavored)
  // ---------------------------------------------------------------------------

  private getHelpText(): string {
    return [
      "👋 **I'm Feral** — I manage Claude Code workers on your dedicated machine.",
      "",
      "💬 **Talk to me:**",
      "In a project channel, just type — messages go straight to the worker.",
      "",
      "🔧 **Management commands:**",
      "`/feral new <name>` — Create a project",
      "`/feral start [project]` — Start a worker",
      "`/feral status` — Overview of all projects",
      "`/feral pause [project]` — Pause a worker",
      "`/feral resume [project]` — Resume",
      "`/feral stop [project]` — Stop permanently",
      "`/feral tell <project> <msg>` — Send a message to a worker",
      "`/feral logs [project]` — View output",
      "`/feral cleanup` — Clean up worktrees",
      "`/feral dashboard` — Open the web dashboard",
      "",
      "⚡ **Claude Code commands** (native slash commands!):",
      "`/model sonnet` — Switch model",
      "`/effort high` — Set effort level",
      "`/compact` — Compact context",
      "`/plan` — Toggle plan mode",
      "`/cost` — Show token usage",
      "`/cc <command>` — Any other Claude Code slash command",
      "",
      "_In project channels, the project is auto-detected._",
    ].join("\n");
  }
}
