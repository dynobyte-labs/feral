import "dotenv/config";
import { z } from "zod";
import path from "path";
import os from "os";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_OWNER_ID: z.string().optional(),

  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),

  DASHBOARD_TOKEN: z.string().optional(),
  DASHBOARD_URL: z.string().optional(),
  SSH_HOST: z.string().optional(),  // e.g. "user@100.x.y.z" or "user@my-mac" for remote terminal access

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_ORG: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  REPLICATE_API_TOKEN: z.string().optional(),
  STABILITY_API_KEY: z.string().optional(),

  PORT: z.coerce.number().default(3000),
  PROJECTS_DIR: z.string().default("~/projects"),
  MAX_WORKERS: z.coerce.number().default(4),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Get the first non-internal IPv4 address (local network IP). */
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "localhost";
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = {
  anthropicApiKey: env.ANTHROPIC_API_KEY,

  slack: {
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    ownerId: env.SLACK_OWNER_ID,
    enabled: !!(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN),
  },

  discord: {
    botToken: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    enabled: !!env.DISCORD_BOT_TOKEN,
  },

  dashboard: {
    token: env.DASHBOARD_TOKEN,
    authEnabled: !!env.DASHBOARD_TOKEN,
    url: env.DASHBOARD_URL || `http://${getLocalIp()}:${env.PORT}`,
    sshHost: env.SSH_HOST || "",
  },

  github: {
    token: env.GITHUB_TOKEN,
    org: env.GITHUB_ORG,
    enabled: !!env.GITHUB_TOKEN,
  },

  imageGen: {
    openaiKey: env.OPENAI_API_KEY,
    replicateToken: env.REPLICATE_API_TOKEN,
    stabilityKey: env.STABILITY_API_KEY,
  },

  port: env.PORT,
  projectsDir: expandHome(env.PROJECTS_DIR),
  maxWorkers: env.MAX_WORKERS,
  logLevel: env.LOG_LEVEL,

  paths: {
    data: path.resolve("data"),
    db: path.resolve("data/state.db"),
    logs: path.resolve("data/logs"),
  },
} as const;

export type Config = typeof config;
