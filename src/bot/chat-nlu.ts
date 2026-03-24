import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";

/**
 * Tools that map to feral's capabilities.
 * Claude picks the right one based on natural language.
 */
const FERAL_TOOLS: Anthropic.Tool[] = [
  {
    name: "create_project",
    description:
      "Create a new project. Templates: empty, web, api, ios, fullstack.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Project name (lowercase, no spaces — will be used as folder and channel name)",
        },
        template: {
          type: "string",
          enum: ["empty", "web", "api", "ios", "fullstack"],
          description: "Project template. Default: empty",
        },
        description: {
          type: "string",
          description: "Short description of what this project does",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "start_worker",
    description:
      "Start a Claude Code worker on a project with specific instructions.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name",
        },
        branch: {
          type: "string",
          description: "Git branch to work on. Default: main",
        },
        prompt: {
          type: "string",
          description:
            "Instructions for what the Claude Code worker should do",
        },
      },
      required: ["project", "prompt"],
    },
  },
  {
    name: "get_status",
    description:
      "Get status of all projects and workers, or a specific project.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description:
            "Specific project name. Omit to get status of all projects.",
        },
      },
    },
  },
  {
    name: "pause_worker",
    description: "Pause a running worker. Saves state so it can be resumed.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name to pause",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "resume_worker",
    description: "Resume a paused project with optional additional instructions.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name to resume",
        },
        instructions: {
          type: "string",
          description:
            "Additional instructions for the worker when it resumes",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "stop_worker",
    description: "Stop a worker permanently. Use pause if you want to resume later.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name to stop",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message or instruction to a running worker. Use this when the user wants to tell a worker something, give it feedback, or redirect its work.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name",
        },
        message: {
          type: "string",
          description: "Message to send to the worker",
        },
      },
      required: ["project", "message"],
    },
  },
  {
    name: "get_logs",
    description:
      "View recent terminal output from a running worker.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name",
        },
        lines: {
          type: "number",
          description: "Number of lines to show. Default: 30",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "cleanup",
    description: "Clean up completed git worktrees to free disk space.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "show_help",
    description:
      "Show what feral can do. Use when the user asks for help or seems unsure.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
];

const SYSTEM_PROMPT = `You are the Feral assistant — a friendly Slack chatbot that manages a team of Claude Code AI workers running on a dedicated machine.

Your job is to understand what the user wants and call the right tool. Be conversational and brief.

Context about feral:
- Users create "projects" which are git repos with Claude Code workers
- Workers run in tmux sessions with --dangerously-skip-permissions
- Projects can be paused (saves state) and resumed later
- Each project gets its own Slack channel where messages route directly to the worker
- Templates available: empty, web (Next.js), api (Express), ios, fullstack (monorepo)

Guidelines:
- If the user is chatting in a project channel (you'll be told which project), assume commands are about that project
- If they just say something conversational like "thanks" or "cool", respond naturally without calling a tool
- If the message is meant for the worker (like code instructions or feedback), use send_message
- Keep responses short — this is Slack, not an essay
- Use emoji sparingly but naturally`;

export interface NluResult {
  /** The tool Claude chose, or null if it just wants to chat */
  action: string | null;
  /** Parameters for the tool */
  params: Record<string, unknown>;
  /** Claude's conversational response text */
  reply: string;
}

// ---------------------------------------------------------------------------
// Conversation history — keeps the last N exchanges per channel for context
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10; // keep last 10 message pairs per channel
const conversationHistory: Map<string, Anthropic.MessageParam[]> = new Map();

/** Get the message history for a channel, or create a new empty one. */
function getHistory(channelId: string): Anthropic.MessageParam[] {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, []);
  }
  return conversationHistory.get(channelId)!;
}

/** Append a user message and assistant response to the channel history. */
function pushHistory(channelId: string, userMsg: string, assistantMsg: string): void {
  const history = getHistory(channelId);
  history.push({ role: "user", content: userMsg });
  history.push({ role: "assistant", content: assistantMsg });
  // Trim to keep only the last N exchanges (N*2 messages)
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

/**
 * Parse a natural language message into a feral action using Claude.
 */
export async function parseIntent(
  message: string,
  context?: {
    /** If the message came from a project channel, which project */
    currentProject?: string;
    /** Brief summary of current state for context */
    stateContext?: string;
    /** Channel/thread ID for maintaining conversation history */
    channelId?: string;
  }
): Promise<NluResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key — can't do NLU
    return {
      action: null,
      params: {},
      reply: "",
    };
  }

  const client = new Anthropic({ apiKey });

  // Build the user message with context
  let userMsg = message;
  if (context?.currentProject) {
    userMsg = `[Context: This message is in the #proj-${context.currentProject} channel, so it's about the "${context.currentProject}" project]\n\n${message}`;
  }
  if (context?.stateContext) {
    userMsg = `[Current state: ${context.stateContext}]\n\n${userMsg}`;
  }

  // Build messages array with conversation history
  const history = context?.channelId ? getHistory(context.channelId) : [];
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMsg },
  ];

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      tools: FERAL_TOOLS,
      messages,
    });

    // Extract tool use and text from the response
    let action: string | null = null;
    let params: Record<string, unknown> = {};
    let reply = "";

    for (const block of response.content) {
      if (block.type === "tool_use") {
        action = block.name;
        params = block.input as Record<string, unknown>;
      } else if (block.type === "text") {
        reply = block.text;
      }
    }

    // Save to conversation history
    if (context?.channelId) {
      const assistantText = reply || (action ? `[action: ${action}]` : "");
      if (assistantText) {
        pushHistory(context.channelId, userMsg, assistantText);
      }
    }

    return { action, params, reply };
  } catch (err) {
    logger.error(`NLU parse failed: ${err}`);
    return {
      action: null,
      params: {},
      reply: "",
    };
  }
}

/**
 * Check if the Anthropic API key is available for NLU.
 */
export function isNluAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0);
}
