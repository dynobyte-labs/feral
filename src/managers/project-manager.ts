import { execSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { db, queries } from "../db/database.js";
import { logger } from "../logger.js";

/** Resolve full path to gh CLI — Node's PATH on macOS often misses /opt/homebrew/bin. */
const GH_PATH = (() => {
  for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try {
      execSync(`test -x "${p}"`, { stdio: "pipe" });
      return p;
    } catch { /* try next */ }
  }
  return "gh";
})();

/** Resolve full path to git — same PATH issue. */
const GIT_PATH = (() => {
  for (const p of ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]) {
    try {
      execSync(`test -x "${p}"`, { stdio: "pipe" });
      return p;
    } catch { /* try next */ }
  }
  return "git";
})();

export type ProjectTemplate = "empty" | "web" | "api" | "ios" | "fullstack";

export interface Project {
  id: string;
  name: string;
  path: string;
  repo_url: string | null;
  slack_channel_id: string | null;
  discord_channel_id: string | null;
  template: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectOptions {
  name: string;
  template?: ProjectTemplate;
  description?: string;
  skipGithub?: boolean;
  skipSlack?: boolean;
}

const TEMPLATES: Record<ProjectTemplate, () => Record<string, string>> = {
  empty: () => ({
    ".gitignore": "node_modules/\ndist/\n.env\n.DS_Store\n",
  }),
  web: () => ({
    ".gitignore": "node_modules/\ndist/\n.next/\n.env\n.DS_Store\n",
    "package.json": JSON.stringify({
      name: "web-app",
      private: true,
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { next: "latest", react: "latest", "react-dom": "latest" },
    }, null, 2),
  }),
  api: () => ({
    ".gitignore": "node_modules/\ndist/\n.env\n.DS_Store\n",
    "package.json": JSON.stringify({
      name: "api-service",
      private: true,
      type: "module",
      scripts: { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" },
      dependencies: { express: "^4.21.0" },
      devDependencies: { tsx: "^4.19.0", typescript: "^5.7.0", "@types/express": "^5.0.0", "@types/node": "^22.0.0" },
    }, null, 2),
    "src/index.ts": `import express from "express";\nconst app = express();\napp.get("/", (_, res) => res.json({ status: "ok" }));\napp.listen(3001, () => console.log("API running on :3001"));\n`,
  }),
  ios: () => ({
    ".gitignore": "build/\nDerivedData/\n*.xcuserstate\n.DS_Store\nPods/\n",
    "README.md": "# iOS App\n\nOpen the .xcworkspace in Xcode or build with `xcodebuild`.\n",
  }),
  fullstack: () => ({
    ".gitignore": "node_modules/\ndist/\n.next/\n.env\n.DS_Store\n",
    "package.json": JSON.stringify({
      name: "fullstack-app",
      private: true,
      workspaces: ["apps/*", "packages/*"],
    }, null, 2),
    "apps/.gitkeep": "",
    "packages/.gitkeep": "",
  }),
};

export class ProjectManager {
  /**
   * Create a new project: local folder, git repo, optional GitHub repo.
   * Slack channel creation is handled by the SlackBot separately.
   */
  async create(options: CreateProjectOptions): Promise<Project> {
    const { name, template = "empty", description = "" } = options;
    const id = randomUUID();
    const projectPath = path.join(config.projectsDir, name);

    // Check for conflicts
    if (queries.getProjectByName.get(name)) {
      throw new Error(`Project "${name}" already exists`);
    }
    if (fs.existsSync(projectPath)) {
      throw new Error(`Directory already exists: ${projectPath}`);
    }

    logger.info(`Creating project: ${name} (${template})`, { id });

    // Step 1: Create directory and scaffold template
    fs.mkdirSync(projectPath, { recursive: true });
    const files = TEMPLATES[template]();
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(projectPath, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    // Always create a PROJECT_BRIEF.md
    const brief = [
      `# ${name}`,
      ``,
      `Template: ${template}`,
      `Created: ${new Date().toISOString()}`,
      `Description: ${description || "(none yet)"}`,
      ``,
      `## Status`,
      `Just created. No work started yet.`,
      ``,
      `## Next Steps`,
      `- Initial setup`,
    ].join("\n");
    fs.writeFileSync(path.join(projectPath, "PROJECT_BRIEF.md"), brief);

    // Step 2: Git init + initial commit
    execSync(`${GIT_PATH} init && ${GIT_PATH} add -A && ${GIT_PATH} commit -m 'Initial scaffold'`, {
      cwd: projectPath,
      stdio: "pipe",
    });
    logger.info(`Git repo initialized: ${projectPath}`);

    // Step 3: GitHub repo (optional)
    let repoUrl: string | null = null;
    if (config.github.enabled && !options.skipGithub) {
      try {
        const orgFlag = config.github.org ? `--org ${config.github.org}` : "";
        const ghEnv = { ...process.env, GH_TOKEN: config.github.token, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
        execSync(
          `${GH_PATH} repo create ${name} --private ${orgFlag} --source=. --push`,
          { cwd: projectPath, stdio: "pipe", env: ghEnv }
        );
        const remote = execSync(`${GIT_PATH} remote get-url origin`, {
          cwd: projectPath, encoding: "utf-8",
        }).trim();
        repoUrl = remote;
        logger.info(`GitHub repo created: ${repoUrl}`);
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || String(err);
        logger.warn(`Failed to create GitHub repo (continuing without): ${stderr}`);
      }
    }

    // Step 4: Save to database
    queries.createProject.run(id, name, projectPath, repoUrl, null, template, description);
    queries.upsertBrief.run(id, brief);
    queries.addEvent.run(id, null, "project_created", `Project ${name} created with template: ${template}`);

    return queries.getProject.get(id) as Project;
  }

  get(id: string): Project | undefined {
    return queries.getProject.get(id) as Project | undefined;
  }

  getByName(name: string): Project | undefined {
    return queries.getProjectByName.get(name) as Project | undefined;
  }

  list(): Project[] {
    return queries.listProjects.all() as Project[];
  }

  listActive(): Project[] {
    return queries.listActiveProjects.all() as Project[];
  }

  setStatus(id: string, status: string): void {
    queries.updateProjectStatus.run(status, id);
  }

  setSlackChannel(id: string, channelId: string): void {
    db.prepare("UPDATE projects SET slack_channel_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(channelId, id);
  }

  setDiscordChannel(id: string, channelId: string): void {
    db.prepare("UPDATE projects SET discord_channel_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(channelId, id);
  }

  getBrief(id: string): string | null {
    const row = queries.getBrief.get(id) as { content: string } | undefined;
    return row?.content ?? null;
  }

  updateBrief(id: string, content: string): void {
    queries.upsertBrief.run(id, content);
    // Also write to disk
    const project = this.get(id);
    if (project) {
      fs.writeFileSync(path.join(project.path, "PROJECT_BRIEF.md"), content);
    }
  }

  getRecentEvents(id: string, limit = 20): unknown[] {
    return queries.getRecentEvents.all(id, limit) as unknown[];
  }
}
