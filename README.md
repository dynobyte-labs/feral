# feral

Unleash Claude Code on a dedicated machine. Run a team of AI developers safely in dangerous mode, managed from Slack or Discord.

```
Slack / Discord → Feral Orchestrator → Claude Code Workers → Your Repos
```

**One message creates a project.** Feral sets up the folder, git repo, GitHub remote, chat channel, and spins up a Claude Code worker — all wired together so you can talk to the worker directly in your chat platform of choice.

**Pause and resume 20+ projects** while only running 3–4 workers at a time. Session state is preserved. Pick up exactly where you left off.

**Run Claude Code off-leash.** Workers run with `--dangerously-skip-permissions` on an isolated machine — full power, safely contained.

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│  Slack / Discord                                             │
│  "Start a new project called puzzle-quest, an iOS game"      │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────┐
│  FERAL ORCHESTRATOR (Node.js on your machine)                │
│  ├── Creates ~/projects/puzzle-quest/                        │
│  ├── git init + gh repo create (private)                     │
│  ├── Creates #proj-puzzle-quest channel                      │
│  ├── Spawns Claude Code worker in tmux                       │
│  └── Routes chat ↔ Worker bidirectionally                    │
├──────────────────────────────────────────────────────────────┤
│  WORKERS (Claude Code instances — dangerous mode)            │
│  ├── puzzle-quest  feat/themes   ● running                   │
│  ├── landing-page  main          ● running                   │
│  ├── fitness-api   feat/auth     ◌ paused                    │
│  └── meal-planner  main          ● running                   │
└──────────────────────────────────────────────────────────────┘
```

## Requirements

- **macOS on Apple Silicon** (Mac Mini M4 recommended, any M-series works)
- **Node.js 22+**
- **Claude Code** installed globally (`npm install -g @anthropic-ai/claude-code`)
- **Anthropic API key** (Pro or Max plan recommended for rate limits)
- **tmux** (for persistent worker sessions)
- **gh** (GitHub CLI, for automatic repo creation)
- **Tailscale** (for secure remote access — free tier is fine)

Optional:
- **Slack workspace** with a bot (for Slack integration)
- **Discord server** with a bot (for Discord integration — native slash commands!)
- **Xcode** (if building iOS/macOS projects)
- **Docker** (for containerized builds)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/dynobyte-labs/feral.git
cd feral
npm install
```

### 2. Authenticate Claude Code

```bash
claude login
```

This uses your Claude Pro/Max subscription — Claude Code usage is included at no extra cost. This is the preferred method over API key auth, which bills per-token.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` with your keys (leave `ANTHROPIC_API_KEY` blank if you used `claude login`):

```env
# Slack (optional — either or both platforms work)
SLACK_BOT_TOKEN=xoxb-...           # For Slack integration
SLACK_APP_TOKEN=xapp-...           # For Slack socket mode

# Discord (optional — either or both platforms work)
DISCORD_BOT_TOKEN=...              # For Discord integration
DISCORD_GUILD_ID=...               # Your server ID (recommended for instant slash command registration)

# Other
GITHUB_TOKEN=ghp_...               # For auto repo creation
```

### 3. Run

```bash
npm run dev
```

The dashboard is at `http://localhost:3000`. Whichever chat integrations are configured will start automatically. Both Slack and Discord can run simultaneously.

### 4. Create your first project

In Slack:
```
!new my-app web "A Next.js web application"
```

In Discord:
```
/feral new name:my-app template:Web description:A Next.js web application
```

Or via API:
```bash
curl -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "template": "web", "description": "A Next.js web application"}'
```

## Chat Commands

### Slack

| Command | Description |
|---------|-------------|
| `!new <name> [template] [description]` | Create project + repo + channel + worker |
| `!start [project] [prompt]` | Start a worker |
| `!status` | Overview of all projects and active workers |
| `!pause [project]` | Pause worker, save state |
| `!resume [project] [instructions]` | Resume with full session history |
| `!stop [project]` | Stop worker permanently |
| `!tell <project> <message>` | Send a message to a running worker |
| `!logs [project] [lines]` | View worker terminal output |
| `!cc /model sonnet` | Claude Code passthrough (any slash command) |
| `!cleanup` | Prune completed git worktrees |
| `!help` | Show all commands |

You can also @mention the bot from any channel for natural language interaction.

### Discord

Discord uses native slash commands with autocomplete:

**Management:**

| Command | Description |
|---------|-------------|
| `/feral new` | Create project (with template picker) |
| `/feral start [project] [prompt]` | Start a worker |
| `/feral status [project]` | Overview of all projects |
| `/feral pause [project]` | Pause a worker |
| `/feral resume [project] [instructions]` | Resume |
| `/feral stop [project]` | Stop permanently |
| `/feral tell <project> <message>` | Send message to a worker |
| `/feral logs [project] [lines]` | View worker output |
| `/feral cleanup` | Clean up worktrees |
| `/feral help` | Show help |

**Claude Code commands** (native slash commands — no prefix hack needed!):

| Command | Description |
|---------|-------------|
| `/model sonnet\|opus\|haiku` | Switch model |
| `/effort high\|medium\|low` | Set effort level |
| `/compact` | Compact context window |
| `/plan` | Toggle plan mode |
| `/cost` | Show token usage |
| `/cc <command>` | Any other Claude Code slash command |

**In project channels:** Any message you type is routed directly to that project's Claude Code worker. Worker output appears in threads to keep the channel clean.

**Auto-resume:** If a worker has died (e.g. idle timeout), typing in the project channel automatically resumes it with your message as the prompt.

## Project Templates

| Template | What you get |
|----------|-------------|
| `empty` | Just .gitignore and PROJECT_BRIEF.md |
| `web` | Next.js project scaffold |
| `api` | Express + TypeScript API scaffold |
| `ios` | Xcode-ready scaffold |
| `fullstack` | npm workspaces with apps/ and packages/ |

## Discord Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.

2. Under **Bot**, click "Reset Token" and copy it — this is your `DISCORD_BOT_TOKEN`.

3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** (required for reading messages in project channels).

4. Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands`, then select these bot permissions: Send Messages, Manage Channels, Create Public Threads, Send Messages in Threads, Read Message History, Embed Links.

5. Open the generated URL to invite the bot to your server.

6. Right-click your Discord server name → Copy Server ID (enable Developer Mode in settings if you don't see this). This is your `DISCORD_GUILD_ID`.

7. Add to your `.env`:
   ```env
   DISCORD_BOT_TOKEN=your-bot-token-here
   DISCORD_GUILD_ID=your-server-id-here
   ```

8. If discord.js isn't already installed: `npm install discord.js`

9. Start Feral — slash commands register automatically. With a `DISCORD_GUILD_ID` they appear instantly; without it, global commands can take up to an hour.

## Dedicated Machine Setup

For a dedicated always-on machine (Mac Mini M4 recommended):

```bash
# Run the full macOS setup (Homebrew, Node, tmux, Tailscale, firewall, etc.)
bash scripts/setup-macos.sh

# Install the launchd agent (auto-starts Feral on login)
bash scripts/install-launchd.sh
```

Then configure:

1. **System Settings → General → Sharing** → Enable Remote Login (SSH)
2. **System Settings → General → Sharing** → Enable Screen Sharing
3. **System Settings → Users & Groups** → Set auto-login
4. **Open Tailscale** → Sign in → Note your Tailscale IP

After setup, access from anywhere:
```bash
# SSH (terminal)
ssh your-user@your-mac.tailnet-name.ts.net

# Dashboard (browser)
http://your-mac.tailnet-name.ts.net:3000

# Claude Code remote control (Claude app on phone)
# Attach to a worker's tmux session and run /rc
```

## Security

Feral runs Claude Code with `--dangerously-skip-permissions`. That flag exists for a reason — it gives Claude full, unrestricted access to the filesystem, shell, and network. The security model is simple: **the machine itself is the sandbox.**

### The Expendable Machine Strategy

The core idea: put nothing on outpost-1 that you'd be upset to lose.

- **No Apple ID signed in** — no iCloud, no Keychain sync
- **No email, no browser logins, no personal data** — treat it like a server
- **Dedicated GitHub account** with fine-grained PATs scoped only to `dynobyte-labs` repos
- **SSH key-only auth** — disable password login entirely
- **Tailscale for network access** — no ports exposed to the internet, no port forwarding
- **Firewall ON + stealth mode** — the setup script configures this automatically
- **Reimageable in 30 minutes** — if anything goes wrong, factory reset and re-run `setup-macos.sh`

### Credential Protection

Feral includes a pre-commit hook that scans for accidentally staged secrets:

```bash
bash scripts/install-hooks.sh
```

This blocks commits containing Anthropic API keys, Slack tokens, GitHub PATs, OpenAI keys, private keys, and `.env` files. The `.gitignore` also excludes `.env`, `.pem`, `.key`, and the `data/` directory.

### What to Watch For

**API key exposure** — Your Anthropic key lives in `.env` on the machine. A rogue Claude Code session could theoretically read it and include it in output. Use a separate API key for Feral, and the pre-commit hook will catch accidental commits.

**GitHub token scope** — Use a fine-grained PAT scoped only to repos under your org, with minimal permissions (contents + pull requests). Never use a classic token with full repo access.

**Network requests** — Claude Code in dangerous mode can make arbitrary HTTP requests. Since there's nothing sensitive on the machine, exfiltration risk is minimal. For extra hardening, configure outbound firewall rules to allow only GitHub, npm, and the Anthropic API.

**Bot tokens** — If your Slack or Discord bot token is compromised, someone could post as your bot. Consider using a dedicated workspace/server for Feral, or limit the bot's channel scope.

### What's NOT a Risk

- Claude Code can't escape the machine — it runs in a terminal process
- It can't access your laptop, phone, or other devices on your network
- It can't spend beyond your Anthropic API plan limits
- If it breaks the OS, you factory reset and you're back in 30 minutes

### Weekly Maintenance

```bash
# Clean up worktrees, Xcode derived data, Docker images
bash scripts/cleanup.sh
```

## REST API

All functionality is available via the REST API:

```
GET    /api/projects              List all projects
GET    /api/projects/:id          Get project details + brief + events
POST   /api/projects              Create project
POST   /api/projects/:id/resume   Resume a paused project

GET    /api/workers               List active workers
POST   /api/workers               Spawn a worker
POST   /api/workers/:id/pause     Pause a worker
POST   /api/workers/:id/stop      Stop a worker
POST   /api/workers/:id/message   Send message to worker
GET    /api/workers/:id/logs      Get worker terminal output

GET    /api/health                System health + stats
```

## Architecture

```
feral/
├── src/
│   ├── index.ts                  # Entry point — starts all services
│   ├── config.ts                 # Environment config with validation
│   ├── logger.ts                 # Winston logging
│   ├── db/
│   │   └── database.ts           # SQLite schema + prepared statements
│   ├── managers/
│   │   ├── project-manager.ts    # Create/list/manage projects
│   │   └── worker-manager.ts     # Spawn/pause/resume/stop workers
│   ├── bot/
│   │   ├── bot-controller.ts     # Shared logic (actions, NLU, CC passthrough)
│   │   ├── slack-bot.ts          # Slack adapter (Bolt, !commands, @mentions)
│   │   ├── discord-bot.ts        # Discord adapter (slash commands, threads)
│   │   └── chat-nlu.ts           # Natural language intent parsing (Haiku)
│   └── api/
│       └── routes.ts             # Express REST API
├── dashboard/
│   └── index.html                # Web dashboard (vanilla HTML/JS)
├── scripts/
│   ├── setup-macos.sh            # Full macOS setup for dedicated machine
│   ├── install-launchd.sh        # Auto-start on boot
│   ├── install-hooks.sh          # Pre-commit hook for credential safety
│   └── cleanup.sh                # Weekly disk space cleanup
├── data/                         # SQLite DB + logs (gitignored)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## How Pause/Resume Works

When you pause a project:
1. Feral captures the worker's session ID and recent output
2. Updates the `PROJECT_BRIEF.md` in the project directory
3. Tears down the tmux session (frees RAM)
4. The git worktree and all files stay on disk

When you resume:
1. Feral looks up the previous session ID
2. Starts a new Claude Code instance with `--resume <session-id>`
3. Injects the project brief as context
4. Claude Code loads the full conversation history and picks up where it left off

You can have 20+ projects in the database while only 3–4 workers run at a time.

## Workers Have Full Claude Code Power

Each worker is a complete Claude Code instance running in dangerous mode. That means:

- **Subagents** — Up to 10 parallel subagents per worker
- **Agent Teams** — Coordinate multiple teammates (set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
- **Plan mode** — `/plan` before executing
- **Extended thinking** — Deep reasoning for complex tasks
- **MCP servers** — Connect to any MCP server per-project
- **`/remote-control`** — Connect from Claude mobile app via QR code
- **Full filesystem access** — No permission prompts, ever

## Why "Feral"?

Claude Code is powerful, but normally it's leashed — running on your laptop, asking permission for every file write, stopping when your lid closes. Feral takes it off the leash. It runs on a dedicated machine in `--dangerously-skip-permissions` mode with full autonomy, safely isolated from your personal data. Feral Claude: all the power, none of the risk.

## Contributing

PRs welcome. The main areas that need work:

- [ ] Dashboard improvements (log viewer, project creation form)
- [ ] Webhook support (GitHub PR events, CI notifications)
- [ ] Rate limit management across workers
- [ ] Multi-repo project support
- [ ] Cost tracking per project
- [ ] Matrix/IRC/Telegram adapters (the BotController pattern makes this easy)

## License

MIT
