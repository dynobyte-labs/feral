/**
 * WebSocket-based terminal server.
 *
 * Provides browser access to worker tmux sessions via xterm.js.
 * Uses node-pty (optional native dependency) for proper PTY support.
 * Falls back to tmux capture-pane/send-keys polling if node-pty isn't available.
 */

import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { execSync } from "child_process";
import { logger } from "../logger.js";
import { ProjectManager } from "../managers/project-manager.js";
import { WorkerManager } from "../managers/worker-manager.js";
import { isValidWsToken } from "../api/auth.js";
import { config } from "../config.js";

// node-pty is optional — try to load it
let ptySpawn: ((file: string, args: string[], opts: any) => any) | null = null;
try {
  const mod = await import("node-pty");
  // Handle both ESM default export and CommonJS module.exports
  const ns = mod.default || mod;
  if (typeof ns.spawn === "function") {
    ptySpawn = ns.spawn.bind(ns);
    logger.info("node-pty loaded — web terminal will use full PTY mode");
  } else {
    logger.warn(`node-pty loaded but spawn not found (keys: ${Object.keys(ns).join(", ")})`);
  }
} catch (err) {
  logger.info(`node-pty not available — web terminal will use tmux polling mode (${err})`);
}

interface TerminalSession {
  projectId: string;
  projectName: string;
  pty?: any;
  pollTimer?: ReturnType<typeof setInterval>;
  ws: WebSocket;
}

const activeSessions: Map<WebSocket, TerminalSession> = new Map();

/** Resolve the full path to tmux — node-pty needs it because Node's PATH is often stripped on macOS. */
const TMUX_PATH = (() => {
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try {
      execSync(`test -x "${p}"`, { stdio: "pipe" });
      return p;
    } catch { /* try next */ }
  }
  // Fall back to bare "tmux" and hope it's in PATH
  return "tmux";
})();

function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`${TMUX_PATH} has-session -t "${sessionName}" 2>/dev/null`, { stdio: "pipe" });
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

    // Try full PTY mode first, fall back to polling
    let usedPty = false;

    if (ptySpawn) {
      logger.info(`Spawning PTY: ${TMUX_PATH} attach-session -d -t ${tmuxSession}`);
      try {
        const pty = ptySpawn(TMUX_PATH, ["attach-session", "-d", "-t", tmuxSession], {
          name: "xterm-256color",
          cols: 200,
          rows: 50,
          env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
        });
        logger.info(`PTY spawned (pid: ${pty.pid})`);
        usedPty = true;

        const session: TerminalSession = { projectId: project.id, projectName: project.name, pty, ws };
        activeSessions.set(ws, session);

        pty.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        pty.onExit(({ exitCode }: { exitCode: number }) => {
          logger.info(`Web terminal PTY exited: ${projectName} (code: ${exitCode})`);
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
      } catch (err) {
        logger.error(`PTY spawn failed: ${err} — falling back to polling mode`);
      }
    }

    if (!usedPty) {
      // Polling mode — uses tmux capture-pane for output and send-keys for input.
      // No PTY needed. Works on any system with tmux.
      // We render by positioning each line explicitly with ANSI cursor commands.
      let lastContent = "";
      let cols = 200;
      let rows = 50;

      /** Render captured pane content with proper ANSI cursor positioning. */
      function renderPane(content: string): string {
        const lines = content.split("\n");
        // Move cursor home, then position each line explicitly
        let out = "\x1b[H"; // cursor to 1,1
        for (let i = 0; i < lines.length; i++) {
          // Move to row i+1, column 1; clear the line; write content
          out += `\x1b[${i + 1};1H\x1b[2K${lines[i]}`;
        }
        // Clear any remaining lines below (in case screen shrunk)
        out += `\x1b[${lines.length + 1};1H\x1b[J`;
        return out;
      }

      // Resize the tmux pane to match the browser terminal
      function resizePane() {
        try {
          execSync(`${TMUX_PATH} resize-window -t "${tmuxSession}" -x ${cols} -y ${rows}`, { stdio: "pipe" });
        } catch { /* ignore */ }
      }

      // Send scrollback history first so user can scroll up in xterm.js
      try {
        const scrollback = execSync(
          `${TMUX_PATH} capture-pane -t "${tmuxSession}" -p -e -S -`,
          { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 },
        );
        if (scrollback) {
          // Send scrollback as plain text (not positioned) so it enters xterm scrollback buffer
          ws.send(scrollback);
        }
      } catch { /* ignore */ }

      // Then send the current visible screen positioned properly
      try {
        const initial = execSync(
          `${TMUX_PATH} capture-pane -t "${tmuxSession}" -p -e`,
          { encoding: "utf-8", maxBuffer: 1024 * 1024 },
        );
        if (initial) {
          ws.send(renderPane(initial));
          lastContent = initial;
        }
      } catch { /* ignore */ }

      // Poll for screen changes
      const pollTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(pollTimer);
          return;
        }

        // Check session is still alive
        if (!tmuxSessionExists(tmuxSession)) {
          ws.send("\r\n\x1b[33m[Terminal session ended]\x1b[0m\r\n");
          clearInterval(pollTimer);
          ws.close();
          return;
        }

        try {
          const content = execSync(
            `${TMUX_PATH} capture-pane -t "${tmuxSession}" -p -e`,
            { encoding: "utf-8", maxBuffer: 1024 * 1024 },
          );

          if (content !== lastContent) {
            ws.send(renderPane(content));
            lastContent = content;
          }
        } catch {
          // tmux session may have died
        }
      }, 250);

      const session: TerminalSession = { projectId: project.id, projectName: project.name, pollTimer, ws };
      activeSessions.set(ws, session);

      ws.on("message", (data) => {
        const msg = data.toString();
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            cols = parsed.cols;
            rows = parsed.rows;
            try {
              execSync(`${TMUX_PATH} resize-window -t "${tmuxSession}" -x ${cols} -y ${rows}`, { stdio: "pipe" });
            } catch { /* ignore — window may not resize if other clients attached */ }
            return;
          }
        } catch {
          // Not JSON — regular input
        }

        // Map special characters to tmux key names, send the rest literally
        const keyMap: Record<string, string> = {
          "\r": "Enter",
          "\n": "Enter",
          "\x7f": "BSpace",
          "\x1b[A": "Up",
          "\x1b[B": "Down",
          "\x1b[C": "Right",
          "\x1b[D": "Left",
          "\x1b[5~": "PageUp",
          "\x1b[6~": "PageDown",
          "\x1b[H": "Home",
          "\x1b[F": "End",
          "\x1b": "Escape",
          "\t": "Tab",
          "\x02": "C-b",   // tmux prefix — enables scroll mode (Ctrl-B then [)
          "\x03": "C-c",
          "\x04": "C-d",
          "\x1a": "C-z",
          "\x0c": "C-l",
        };

        try {
          const mapped = keyMap[msg];
          if (mapped) {
            execSync(`${TMUX_PATH} send-keys -t "${tmuxSession}" ${mapped}`, { stdio: "pipe" });
          } else {
            // Use -l (literal) to send text without key name interpretation
            execSync(`${TMUX_PATH} send-keys -t "${tmuxSession}" -l ${JSON.stringify(msg)}`, { stdio: "pipe" });
          }
        } catch (err) {
          logger.debug(`tmux send-keys failed: ${err}`);
        }
      });
    }

    ws.on("close", () => {
      const session = activeSessions.get(ws);
      if (session) {
        logger.info(`Web terminal disconnected: ${session.projectName}`);
        if (session.pty) {
          try { session.pty.kill(); } catch { /* ignore */ }
        }
        if (session.pollTimer) {
          clearInterval(session.pollTimer);
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
