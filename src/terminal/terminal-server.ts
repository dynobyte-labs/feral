/**
 * WebSocket-based terminal server.
 *
 * Provides browser access to worker tmux sessions via xterm.js.
 * Uses node-pty (optional native dependency) for proper PTY support.
 * Falls back to a `script` wrapper if node-pty isn't available.
 */

import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, execSync, ChildProcess } from "child_process";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";
import { isValidWsToken } from "../api/auth.js";
import { config } from "../config.js";

// node-pty is optional — try to load it
let nodePty: any = null;
try {
  nodePty = await import("node-pty");
} catch {
  logger.info("node-pty not available — web terminal will use basic mode (install node-pty for full PTY support)");
}

interface TerminalSession {
  projectId: string;
  projectName: string;
  pty?: any;
  proc?: ChildProcess;
  ws: WebSocket;
}

const activeSessions: Map<WebSocket, TerminalSession> = new Map();

function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach the terminal WebSocket server to an existing HTTP server.
 * Clients connect to ws://host:port/ws/terminal?project=<name>
 */
export function attachTerminalServer(
  server: HttpServer,
  projectManager: ProjectManager,
  _workerManager: WorkerManager,
): void {
  const wss = new WebSocketServer({ server, path: "/ws/terminal" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Auth check — token from query param or cookie
    if (config.dashboard.authEnabled) {
      const token = url.searchParams.get("token");
      const cookieHeader = req.headers.cookie || "";
      const cookieToken = cookieHeader.split(";").find(c => c.trim().startsWith("feral_token="))?.split("=")[1]?.trim();

      if (!isValidWsToken(token || cookieToken || null)) {
        ws.send(JSON.stringify({ error: "Unauthorized. Include ?token= or sign in to the dashboard first." }));
        ws.close();
        return;
      }
    }

    const projectName = url.searchParams.get("project");

    if (!projectName) {
      ws.send(JSON.stringify({ error: "Missing ?project= parameter" }));
      ws.close();
      return;
    }

    const project = projectManager.getByName(projectName);
    if (!project) {
      ws.send(JSON.stringify({ error: `Project "${projectName}" not found` }));
      ws.close();
      return;
    }

    const tmuxSession = `feral-${project.name}`;

    if (!tmuxSessionExists(tmuxSession)) {
      ws.send(JSON.stringify({ error: `No active tmux session for "${projectName}". Start a worker first.` }));
      ws.close();
      return;
    }

    logger.info(`Web terminal connected: ${projectName}`);

    if (nodePty) {
      // Full PTY mode — proper terminal emulation
      const ptySpawn = nodePty.spawn || nodePty.default?.spawn;
      if (!ptySpawn) {
        ws.send(JSON.stringify({ error: "node-pty loaded but spawn not found" }));
        ws.close();
        return;
      }

      const pty = ptySpawn("tmux", ["attach-session", "-t", tmuxSession], {
        name: "xterm-256color",
        cols: 200,
        rows: 50,
        env: process.env as Record<string, string>,
      });

      const session: TerminalSession = { projectId: project.id, projectName: project.name, pty, ws };
      activeSessions.set(ws, session);

      pty.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      pty.onExit(() => {
        logger.info(`Web terminal PTY exited: ${projectName}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("\r\n\x1b[33m[Terminal session ended]\x1b[0m\r\n");
          ws.close();
        }
      });

      ws.on("message", (data) => {
        const msg = data.toString();
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows);
            return;
          }
        } catch {
          // Not JSON — regular input
        }
        pty.write(msg);
      });
    } else {
      // Basic mode — use `script` to wrap in a pseudo-terminal
      const isLinux = process.platform === "linux";
      const args = isLinux
        ? ["-qfc", `tmux attach-session -t "${tmuxSession}"`, "/dev/null"]
        : ["-q", "/dev/null", "tmux", "attach-session", "-t", tmuxSession];

      const proc = spawn("script", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "xterm-256color" },
      });

      const session: TerminalSession = { projectId: project.id, projectName: project.name, proc, ws };
      activeSessions.set(ws, session);

      proc.stdout?.on("data", (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      proc.on("exit", () => {
        logger.info(`Web terminal process exited: ${projectName}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("\r\n\x1b[33m[Terminal session ended]\x1b[0m\r\n");
          ws.close();
        }
      });

      ws.on("message", (data) => {
        const msg = data.toString();
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "resize") return;
        } catch {
          // Not JSON
        }
        proc.stdin?.write(msg);
      });
    }

    ws.on("close", () => {
      const session = activeSessions.get(ws);
      if (session) {
        logger.info(`Web terminal disconnected: ${session.projectName}`);
        if (session.pty) {
          try { session.pty.kill(); } catch { /* ignore */ }
        }
        if (session.proc) {
          try { session.proc.kill(); } catch { /* ignore */ }
        }
        activeSessions.delete(ws);
      }
    });

    ws.on("error", (err) => {
      logger.debug(`Web terminal WebSocket error: ${err}`);
    });
  });

  logger.info("Web terminal server attached (ws://*/ws/terminal?project=<name>)");
}
