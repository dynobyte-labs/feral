import { App as SlackApp } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";
import { parseIntent, isNluAvailable } from "./chat-nlu.js";

/**
 * Slack bot with two interfaces:
 * 1. Natural language (powered by Claude) — just talk to it
 * 2. !commands as a fallback when NLU is unavailable
 *
 * Per-project channels route messages directly to the Claude Code worker,
 * or through NLU to determine intent.
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

    // Register !commands as fallback
    this.registerLegacyCommands();
    // Register the main message handler (NLU + project channel routing)
    this.registerMessageHandler();

    await this.app.start();

    const mode = isNluAvailable() ? "natural language + commands" : "commands only (set ANTHROPIC_API_KEY for natural language)";
    logger.info(`Slack bot started (socket mode, ${mode})`);
  }

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
      const introLines = [
        `:rocket: *Project ${project.name}* initialized.`,
        project.repo_url ? `Repo: ${project.repo_url}` : "",
        `Template: \`${project.template}\``,
        "",
      ];

      if (isNluAvailable()) {
        introLines.push(
          "Just talk to me naturally here. I'll figure out if you're giving instructions to the worker, asking about status, or managing the project.",
          "",
          'Try: _"start working on building a REST API"_ or _"how\'s it going?"_ or _"show me the logs"_'
        );
      } else {
        introLines.push(
          "Send messages here to interact with the Claude Code worker.",
          "Commands: `!status` `!pause` `!resume` `!logs` `!stop`"
        );
      }

      await this.client.chat.postMessage({
        channel: channelId,
        text: introLines.filter(Boolean).join("\n"),
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

  // ---------------------------------------------------------------------------
  // NLU action executor
  // ---------------------------------------------------------------------------

  /**
   * Execute a parsed NLU action and return a Slack-friendly response.
   */
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
        if (!worker) return `:warning: No active worker for ${projectName}`;
        await this.workerManager.pause(worker.id);
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
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) return `:warning: No active worker for ${projectName}`;
        await this.workerManager.stop(worker.id);
        return `:stop_button: *${projectName}* stopped.`;
      }

      case "send_message": {
        const projectName = params.project as string;
        const message = params.message as string;
        const project = this.projectManager.getByName(projectName);
        if (!project) return `:x: Project "${projectName}" not found`;
        const worker = this.workerManager.getForProject(project.id);
        if (!worker) return `:warning: No active worker for ${projectName}. Start or resume one first.`;
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
        if (isNluAvailable()) {
          return [
            ":wave: *I'm Feral* — just talk to me naturally! Here's what I can do:",
            "",
            ":hammer_and_wrench: *Create projects* — _\"create a new web project called my-app for building a todo list\"_",
            ":rocket: *Start workers* — _\"start working on my-app, build the API endpoints\"_",
            ":bar_chart: *Check status* — _\"how are things going?\"_ or _\"status\"_",
            ":pause_button: *Pause/Resume* — _\"pause my-app\"_ or _\"resume my-app and focus on tests\"_",
            ":speech_balloon: *Talk to workers* — just type in a project channel and I'll route it",
            ":page_facing_up: *View logs* — _\"show me the logs for my-app\"_",
            ":stop_button: *Stop workers* — _\"stop my-app\"_",
            "",
            "_You can also use `!commands` if you prefer: `!new`, `!start`, `!status`, `!pause`, `!resume`, `!stop`, `!tell`, `!logs`, `!cleanup`_",
          ].join("\n");
        }
        return [
          ":book: *Feral Commands*",
          "",
          "`!new <name> [template] [description]` — Create a new project",
          "`!start <project> <branch> <prompt>` — Start a worker",
          "`!status` — Overview of all projects",
          "`!pause <project>` — Pause a running worker",
          "`!resume <project> [instructions]` — Resume a paused project",
          "`!stop <project>` — Stop a worker permanently",
          "`!tell <project> <message>` — Send a message to a worker",
          "`!logs <project> [lines]` — View worker output",
          "`!cleanup` — Clean up worktrees",
          "",
          "_Set ANTHROPIC_API_KEY to enable natural language mode!_",
        ].join("\n");
      }

      default:
        return `:thinking_face: I understood the action "${action}" but I don't know how to do that yet.`;
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy !commands (always available as fallback)
  // ---------------------------------------------------------------------------

  private registerLegacyCommands(): void {
    if (!this.app) return;

    this.app.message(/^!new\s+(\S+)\s*(\S+)?\s*(.*)$/i, async ({ say, context }) => {
      const [, name, template, description] = context.matches!;
      try {
        await say(`:hammer_and_wrench: Creating project *${name}*...`);
        const result = await this.executeAction("create_project", {
          name, template: template || "empty", description: description || "",
        });
        await say(result);
      } catch (err) {
        await say(`:x: Failed to create project: ${err}`);
      }
    });

    this.app.message(/^!start\s+(\S+)\s+(\S+)\s+(.+)$/is, async ({ say, context }) => {
      const [, projectName, branch, prompt] = context.matches!;
      try {
        await say(`:rocket: Starting worker for *${projectName}*...`);
        const result = await this.executeAction("start_worker", {
          project: projectName, branch, prompt,
        });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!status$/i, async ({ say }) => {
      try {
        const result = await this.executeAction("get_status", {});
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!pause\s+(\S+)$/i, async ({ say, context }) => {
      const [, projectName] = context.matches!;
      try {
        const result = await this.executeAction("pause_worker", { project: projectName });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!resume\s+(\S+)\s*(.*)$/is, async ({ say, context }) => {
      const [, projectName, instructions] = context.matches!;
      try {
        await say(`:arrow_forward: Resuming *${projectName}*...`);
        const result = await this.executeAction("resume_worker", {
          project: projectName, instructions: instructions || undefined,
        });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!stop\s+(\S+)$/i, async ({ say, context }) => {
      const [, projectName] = context.matches!;
      try {
        const result = await this.executeAction("stop_worker", { project: projectName });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
    });

    this.app.message(/^!logs\s+(\S+)\s*(\d+)?$/i, async ({ say, context }) => {
      const [, projectName, lineCount] = context.matches!;
      try {
        const result = await this.executeAction("get_logs", {
          project: projectName, lines: parseInt(lineCount || "30"),
        });
        await say(result);
      } catch (err) {
        await say(`:x: ${err}`);
      }
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
      const result = await this.executeAction("show_help", {});
      await say(result);
    });
  }

  // ---------------------------------------------------------------------------
  // Main message handler — NLU for natural language, routing for project channels
  // ---------------------------------------------------------------------------

  private registerMessageHandler(): void {
    if (!this.app) return;

    this.app.message(async ({ message, say }) => {
      if (!("text" in message) || !message.text) return;
      if (message.text.startsWith("!")) return; // Handled by legacy commands

      // Skip bot messages to avoid loops
      if ("bot_id" in message && message.bot_id) return;

      const text = message.text.trim();
      const projectId = this.channelToProject.get(message.channel);

      // --- Project channel: smart routing ---
      if (projectId) {
        const project = this.projectManager.get(projectId);
        if (!project) return;

        // If NLU is available, let Claude decide if this is a command or worker message
        if (isNluAvailable()) {
          try {
            const worker = this.workerManager.getForProject(project.id);
            const stateContext = worker
              ? `Project "${project.name}" has an active worker on branch "${worker.branch}" (${worker.message_count} messages sent)`
              : `Project "${project.name}" has no active worker (status: ${project.status})`;

            const nlu = await parseIntent(text, {
              currentProject: project.name,
              stateContext,
            });

            if (nlu.action) {
              // Claude identified a management action
              try {
                const result = await this.executeAction(nlu.action, nlu.params);
                const response = nlu.reply ? `${nlu.reply}\n\n${result}` : result;
                await say(response);
              } catch (err) {
                await say(`:x: ${err}`);
              }
            } else if (nlu.reply) {
              // Claude just wants to chat (e.g., "thanks", "cool")
              await say(nlu.reply);
            } else {
              // No action, no reply — treat as worker message
              if (!worker) {
                await say(`:warning: No active worker for *${project.name}*. Say "start working on..." to spin one up, or "resume" to pick up where you left off.`);
                return;
              }
              try {
                this.workerManager.sendMessage(worker.id, text);
              } catch (err) {
                await say(`:x: Failed to send to worker: ${err}`);
              }
            }
          } catch (err) {
            logger.error(`NLU failed, falling back to direct routing: ${err}`);
            // Fall back to direct worker routing
            this.routeToWorker(project.id, text, say);
          }
          return;
        }

        // No NLU — route directly to worker
        this.routeToWorker(project.id, text, say);
        return;
      }

      // --- Non-project channel: NLU for management commands ---
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
          // If no action and no reply, stay quiet (probably not meant for the bot)
        } catch (err) {
          logger.error(`NLU error: ${err}`);
        }
      }
    });
  }

  /**
   * Direct routing: send message to a project's active worker.
   */
  private async routeToWorker(
    projectId: string,
    text: string,
    say: (msg: string) => Promise<unknown>
  ): Promise<void> {
    const worker = this.workerManager.getForProject(projectId);
    if (!worker) {
      await say(":warning: No active worker for this project. Use `!resume` to start one.");
      return;
    }
    try {
      this.workerManager.sendMessage(worker.id, text);
    } catch (err) {
      await say(`:x: Failed to send to worker: ${err}`);
    }
  }
}
