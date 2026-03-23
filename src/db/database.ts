import Database from "better-sqlite3";
import { config } from "../config.js";
import fs from "fs";

fs.mkdirSync(config.paths.data, { recursive: true });

export const db = new Database(config.paths.db);

// Enable WAL mode for concurrent reads
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Run migrations on import
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    path        TEXT NOT NULL,
    repo_url    TEXT,
    slack_channel_id TEXT,
    discord_channel_id TEXT,
    template    TEXT DEFAULT 'empty',
    description TEXT DEFAULT '',
    status      TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'active', 'paused', 'archived')),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workers (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    session_id  TEXT,
    session_name TEXT,
    branch      TEXT NOT NULL DEFAULT 'main',
    worktree_path TEXT,
    status      TEXT DEFAULT 'starting' CHECK(status IN ('starting', 'running', 'paused', 'completed', 'error', 'stopped')),
    message_count INTEGER DEFAULT 0,
    last_summary TEXT,
    started_at  TEXT DEFAULT (datetime('now')),
    stopped_at  TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_briefs (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id),
    content     TEXT NOT NULL,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT REFERENCES projects(id),
    worker_id   TEXT REFERENCES workers(id),
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workers_project ON workers(project_id);
  CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
  CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`);

// Migrations for existing databases (safe to re-run)
try {
  db.exec(`ALTER TABLE projects ADD COLUMN discord_channel_id TEXT`);
} catch {
  // Column already exists — that's fine
}

// Prepared statements for common operations
export const queries = {
  // Projects
  createProject: db.prepare(`
    INSERT INTO projects (id, name, path, repo_url, slack_channel_id, template, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
  getProjectByName: db.prepare(`SELECT * FROM projects WHERE name = ?`),
  listProjects: db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`),
  listActiveProjects: db.prepare(`SELECT * FROM projects WHERE status = 'active'`),
  updateProjectStatus: db.prepare(`
    UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?
  `),

  // Workers
  createWorker: db.prepare(`
    INSERT INTO workers (id, project_id, session_id, session_name, branch, worktree_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getWorker: db.prepare(`SELECT * FROM workers WHERE id = ?`),
  getActiveWorkerForProject: db.prepare(`
    SELECT * FROM workers WHERE project_id = ? AND status IN ('starting', 'running') LIMIT 1
  `),
  listActiveWorkers: db.prepare(`
    SELECT w.*, p.name as project_name FROM workers w
    JOIN projects p ON w.project_id = p.id
    WHERE w.status IN ('starting', 'running')
  `),
  updateWorkerStatus: db.prepare(`
    UPDATE workers SET status = ?, updated_at = datetime('now') WHERE id = ?
  `),
  updateWorkerSession: db.prepare(`
    UPDATE workers SET session_id = ?, updated_at = datetime('now') WHERE id = ?
  `),
  updateWorkerSummary: db.prepare(`
    UPDATE workers SET last_summary = ?, message_count = ?, updated_at = datetime('now') WHERE id = ?
  `),
  stopWorker: db.prepare(`
    UPDATE workers SET status = 'stopped', stopped_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `),
  pauseWorker: db.prepare(`
    UPDATE workers SET status = 'paused', stopped_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `),
  getLastWorkerForProject: db.prepare(`
    SELECT * FROM workers WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
  `),
  listAllWorkers: db.prepare(`
    SELECT w.*, p.name as project_name FROM workers w
    JOIN projects p ON w.project_id = p.id
    ORDER BY w.started_at DESC
    LIMIT 100
  `),

  // Project briefs
  upsertBrief: db.prepare(`
    INSERT INTO project_briefs (project_id, content, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
  `),
  getBrief: db.prepare(`SELECT * FROM project_briefs WHERE project_id = ?`),

  // Events
  addEvent: db.prepare(`
    INSERT INTO events (project_id, worker_id, type, message) VALUES (?, ?, ?, ?)
  `),
  getRecentEvents: db.prepare(`
    SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
  `),
};
