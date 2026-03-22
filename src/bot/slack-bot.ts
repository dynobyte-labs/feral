import { App as SlackApp } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";

/**
 * Slack bot that provides two-way communication:
 * - Commands in any channel to manage projects/workers
 * - Per-project channels where messages route to the worker
 */
export class SlackBot {
  private app: SlackApp | null = null;
  private client: WebClient | null = null;
  private projectManager: ProjectManager;
  private workerManager: WorkerManager;

  /** Maps Slack channel IDs to project IDs for routing */
  private channelToProject: Map<string, string> = new Map();

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

    // Load existing channel mappings from database
    for (const project of this.projectManager.list()) {
      if (project.slack_channel_id) {
        this.channelToProject.set(project.slack_channel_id, project.id);
      }
    }

    this.registerCommands();
    this.registerChannelListener();

    await this.app.start();
    logger.info("Slack bot started (socket mode)");
  }

  /**
   * Create a Slack channel for a project and wire it up.
   */
  async createProjectChannel(projectId: string): Promise<string | null> {
    if (!this.client) return null;

    const project = this.projectManager.get(projectId);
    if (!project) return null;

    try {
      // Slack channel names: lowercase, numbers, hyphens only. Max 80 chars.
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
          "Send messages here to interact with the Claude Code worker.",
          "Commands: `!status` `!pause` `!resume` `!logs` `!stop`",
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

  private registerCommands(): void {
    if (!this.app) return;

    // !new <name> <template> <description>
    this.app.message(/^!new\s+(\S+)\s*(\S+)?\s*(.*)$/i, async ({ say, context }) => {
      const [, name, template, description] = context.matches!;
      try {
        await say(`:hammer_and_wrench: Creating project *${name}*...`);

        const project = await this.projectManager.create({
          name,
          template: (template as any) || "empty",
          description: description || "",
        });

        const channelId = await this.createProjectChannel(project.id);

        await say([
          `:white_check_mark: Project *${name}* created!`,
          `> Path: \`${project.path}\``,
          project.repo_url ? `> Repo: ${project.repo_url}` : "",
          channelId ? `> Channel: <#${channelId}>` : "",
          "",
          `Start a worker: \`!start ${name} main "Your instructions here"\``,
        ].filter(Boolean).join("\n"));
      } catch (err) {
        await say(`:x: Failed to create project: ${err}`);
      }
    });

    // !start <project> <branch> <prompt>
    this.app.message(/^!start\s+(\S+)\s+(\S+)\s+(.+)$/is, async ({ say, context }) => {
      const [, projectName, branch, prompt] = context.matches!;
      try {
        const project = this.projectManager.getByName(projectName);
        if (!project) { await say(`:x: Project "${projectName}" not found`); return; }

        await say(`:rocket: Starting worker for *${projectName}* on \`${branch}\`...`);
        const worker = await this.workerManager.spawn({
          projectId: project.id,
          prompt,
          branch,
        });
        await say(`:white_check_mark: Worker \`${worker.id}\` running.`);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    // !status
    this.app.message(/^!status$/i, async ({ say }) => {
      const projects = this.projectManager.list();
      const activeWorkers = this.workerManager.listActive();

      if (projects.length === 0) {
        await say("No projects yet. Create one with `!new <name> <template> <description>`");
        return;
      }

      const lines = projects.map((p) => {
        const worker = activeWorkers.find((w) => w.project_id === p.id);
        const statusEmoji = {
          active: ":large_green_circle:",
          paused: ":large_orange_circle:",
          idle: ":white_circle:",
          archived: ":black_circle:",
        }[p.status] || ":white_circle:";

        const workerInfo = worker
          ? ` — \`${worker.branch}\` (${worker.message_count} msgs)`
          : "";

        return `${statusEmoji} *${p.name}* [${p.status}]${workerInfo}`;
      });

      await say([
        `:bar_chart: *Project Status* (${activeWorkers.length}/${config.maxWorkers} workers active)`,
        "",
        ...lines,
      ].join("\n"));
    });

    // !pause <project>
    this.app.message(/^!pause\s+(\S+)$/i, async ({ say, context }) => {
      const [, projectName] = context.matches!;
      try {
        const project = this.projectManager.getByName(projectName);
        if (!project) { await say(`:x: Project "${projectName}" not found`); return; }

        const worker = this.workerManager.getForProject(project.id);
        if (!worker) { await say(`:warning: No active worker for ${projectName}`); return; }

        await this.workerManager.pause(worker.id);
        await say(`:pause_button: *${projectName}* paused. Resume with \`!resume ${projectName}\``);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    // !resume <project> [additional instructions]
    this.app.message(/^!resume\s+(\S+)\s*(.*)$/is, async ({ say, context }) => {
      const [, projectName, additionalPrompt] = context.matches!;
      try {
        const project = this.projectManager.getByName(projectName);
        if (!project) { await say(`:x: Project "${projectName}" not found`); return; }

        await say(`:arrow_forward: Resuming *${projectName}*...`);
        const worker = await this.workerManager.resume(project.id, additionalPrompt || undefined);
        await say(`:white_check_mark: Worker \`${worker.id}\` resumed.`);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    // !stop <project>
    this.app.message(/^!stop\s+(\S+)$/i, async ({ say, context }) => {
      const [, projectName] = context.matches!;
      try {
        const project = this.projectManager.getByName(projectName);
        if (!project) { await say(`:x: Project "${projectName}" not found`); return; }

        const worker = this.workerManager.getForProject(project.id);
        if (!worker) { await say(`:warning: No active worker for ${projectName}`); return; }

        await this.workerManager.stop(worker.id);
        await say(`:stop_button: *${projectName}* stopped.`);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    // !logs <project> [lines]
    this.app.message(/^!logs\s+(\S+)\s*(\d+)?$/i, async ({ say, context }) => {
      const [, projectName, lineCount] = context.matches!;
      const project = this.projectManager.getByName(projectName);
      if (!project) { await say(`:x: Project "${projectName}" not found`); return; }

      const worker = this.workerManager.getForProject(project.id);
      if (!worker) { await say(`:warning: No active worker for ${projectName}`); return; }

      const output = this.workerManager.getOutput(worker.id, parseInt(lineCount || "30"));
      await say(`\`\`\`\n${output.slice(-3000)}\n\`\`\``);
    });

    // !tell <project> <message>
    this.app.message(/^!tell\s+(\S+)\s+(.+)$/is, async ({ say, context }) => {
      const [, projectName, message] = context.matches!;
      try {
        const project = this.projectManager.getByName(projectName);
        if (!project) { await say(`:x: Project "${projectName}" not found`); return; }

        const worker = this.workerManager.getForProject(project.id);
        if (!worker) { await say(`:warning: No active worker for ${projectName}`); return; }

        this.workerManager.sendMessage(worker.id, message);
        await say(`:speech_balloon: Sent to *${projectName}*`);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    // !cleanup
    this.app.message(/^!cleanup$/i, async ({ say }) => {
      const projects = this.projectManager.list();
      let cleaned = 0;
      for (const p of projects) {
        try {
          this.workerManager.cleanupWorktrees(p.path);
          cleaned++;
        } catch { /* ignore */ }
      }
      await say(`:broom: Cleaned up worktrees for ${cleaned} projects.`);
    });

    // !help
    this.app.message(/^!help$/i, async ({ say }) => {
      await say([
        ":book: *Feral Commands*",
        "",
        "`!new <name> [template] [description]` — Create a new project (templates: empty, web, api, ios, fullstack)",
        "`!start <project> <branch> <prompt>` — Start a worker on a project",
        "`!status` — Overview of all projects and workers",
        "`!pause <project>` — Pause a running worker (saves state)",
        "`!resume <project> [instructions]` — Resume a paused project",
        "`!stop <project>` — Stop a worker permanently",
        "`!tell <project> <message>` — Send a message to a running worker",
        "`!logs <project> [lines]` — View worker output",
        "`!cleanup` — Clean up completed worktrees",
        "`!help` — Show this message",
      ].join("\n"));
    });
  }

  /**
   * Listen for messages in project channels and route them to workers.
   */
  private registerChannelListener(): void {
    if (!this.app) return;

    this.app.message(async ({ message, say }) => {
      // Only handle messages in project channels that aren't commands
      if (!("text" in message) || !message.text) return;
      if (message.text.startsWith("!")) return; // Skip commands

      const projectId = this.channelToProject.get(message.channel);
      if (!projectId) return; // Not a project channel

      const worker = this.workerManager.getForProject(projectId);
      if (!worker) {
        await say(":warning: No active worker for this project. Use `!resume` to start one.");
        return;
      }

      // Route message to worker
      try {
        this.workerManager.sendMessage(worker.id, message.text);
        // Don't reply — the worker's output will be streamed back via the event listener
      } catch (err) {
        await say(`:x: Failed to send to worker: ${err}`);
      }
    });
  }
}
