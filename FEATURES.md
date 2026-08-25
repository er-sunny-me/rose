# 🌟 Complete Feature List — Rose AI Agent Platform

Rose is a **local-first, general-purpose AI agent platform** with tools, memory,
automation, research, multi-agent orchestration and Gemini Live voice.

---

## 0. 🎨 Setup TUI & Configuration (Phase 33)

A premium full-screen terminal configuration experience (`src/setup/`, `src/tui/`):

| Area | Details |
|---|---|
| First-run detection | Bare `rose` opens the wizard once; versioned setup state, legacy-config migration |
| Full-screen TUI | Alternate buffer, diff renderer, resize handling, min-size fallback screen |
| Keyboard | Arrows / Tab / Shift+Tab / Enter / Esc / Space / Ctrl+C·K·R·L; mouse clicks & scroll where supported |
| Sections | Welcome · AI Provider (+ real Test Connection) · Workspace (+ project detection) · Memory · Security · Appearance (live theme/accent/density preview) · Web Control (port checks) · Review (masked diff) · Health Check · Complete |
| Config safety | Draft → validate → backup → atomic write → verify → rollback on failure; `--reset` keeps memory/projects and backs up first |
| Secrets | Masked everywhere; never logged, never echoed in inputs or diffs |
| Accessibility | `--plain` linear flow, NO_COLOR/ASCII degradation, high-contrast option, keyboard-only operation |
| Shared engine | `rose doctor` + TUI health screen use one diagnostic suite (`src/setup/health.ts`) |

Commands: `rose`, `rose setup [--reset|--plain|--no-color|--debug]`, `rose config`,
`rose doctor`, `rose status`, `rose web`. Tests: `npm run test:phase33`.

---

## 1. 🧠 Model Routing (Multi-Provider)

Rose is not locked to a single provider. The Model Router (`src/router.ts`) picks the
right model per task:

| Provider | Access | Notes |
|---|---|---|
| Google Gemini | Direct API + Live WebSocket | Text + real-time voice |
| Anthropic Claude | Direct API | Claude 3.5 Sonnet / Opus / Haiku |
| OpenAI GPT | Direct API | GPT-4o / GPT-4o Mini / GPT-4 Turbo |
| OpenRouter | Direct API (external) | 400+ models via one key — discovery-driven, capability-aware (Phase 35) |
| Antigravity Proxy | Local proxy | Claude & GPT through one endpoint |

Routing hints (`fast`, `smart`, `vision`, etc.) let subsystems request the class of model they
need instead of a hard-coded name.

### OpenRouter specifics (`src/providers/openrouter.ts`, Phase 35)
- **Naming**: rose-style ids `openrouter/<vendor>/<model>`; prefix stripped automatically on the wire.
- **Discovery**: live `/models` catalog → context length, tool support, vision modality, pricing badges in setup; failed discovery still works with explicitly configured models.
- **Streaming**: SSE streaming implemented inside the provider contract — same normalized output shape.
- **Tool calling**: native `tool_calls` are converted into Rose's existing ```tool fenced protocol, so Security/Policy/ToolExecutor paths apply unchanged.
- **Usage/cost**: prompt/completion/cached tokens + API-computed cost recorded into Telemetry and CostEngine — never invented.
- **Errors**: mapped to Rose categories (auth failure, invalid model, rate limit w/ Retry-After gate, quota, timeout, malformed response).
- **Privacy**: marked as an external/remote provider; keys masked everywhere (logs, doctor, diffs).

---

## 2. 💬 Interaction Interfaces

### Terminal CLI (`npm run dev`)
- Colored, emoji-rich terminal UI with tab-completion for all `/` commands
- Full conversation history, session management, export

### Chat TUI (`rose tui`) — Phase 36
Full-screen chat built on the Rose TUI engine:
- Scrollable transcript + single-line input; streaming replies when the provider supports it
- **Live MODEL panel**: provider kind, model id, capability tier (High/Low/Local), context window (k), health dot — plus tools/vision/price chips from discovery when available
- **LAST REPLY panel** shows the model that *actually* answered (router fallbacks are visible), wall time, token usage and API-reported cost
- `Esc` quit-confirm, `Ctrl+C` instant safe exit, `Ctrl+L` clear, ↑↓ / mouse-wheel scroll-back
- Graceful small-terminal guard and non-TTY guidance (`rose web` suggestion)

### Headless Server (`npm run dev -- --server`)
- Express REST API (`src/server.ts`): sessions, messages, tasks, goals,
  diagnostics, agents, policies, simulations, incidents, reliability runs
- Health/readiness probes (`/health`, `/ready`)
- Serves the web dashboard

### Web Dashboard (`ui/`)
- React + Vite app: **Chat**, **Overview**, **Settings** pages
- Talks to the server's REST API

---

## 3. 🎙️ Voice (Gemini Live)

- Real-time Audio-to-Audio over WebSocket (gemini live preview)
- Voices: **Puck** (default), Charon, Kore, Fenrir, Aoede
- Audio playback + microphone recording via ffmpeg/ffplay backends (auto-detected)
- `/voice`, `/text`, `/voices`, `/record`, `/stop`, `/mic`, `/devices`
- Automatic fallback to standard text API when Live API is unavailable
- Export conversations as `.txt`, audio as `.pcm`

---

## 4. 🔧 Built-in Tools (`src/tools.ts`)

| Tool | What it does |
|---|---|
| `save_memory` | Persist facts/preferences for future sessions |
| `search_memory` | Semantic search over stored memories |
| `web_search` | Internet search |
| `fetch_page` | Fetch and read any web page |
| `execute_command` | Run terminal commands (filesystem/system control) |
| `service_github` | GitHub integration |
| `service_calendar` | Calendar integration |
| `service_email` | Email integration |

Capability routing (`src/capabilities.ts`) detects which capabilities a goal needs
and tells the model what is available/unavailable.

---

## 5. 👥 Multi-Agent Orchestration (`src/agents.ts`)

A Supervisor decomposes complex goals and delegates to specialist sub-agents:

1. **Coding Agent** — write/modify/debug code
2. **Source Discovery Agent** — locate relevant files/repos
3. **Research Agent** — deep web research
4. **Security Agent** — security review
5. **Reviewer Agent** — code/diff review
6. **Testing Agent** — write and run tests
7. **Analysis Agent** — data/log analysis

Sub-agents run in parallel where possible; results are merged by the supervisor.

---

## 6. 🎯 Goals & Planning (`src/goals/`)

- Long-horizon goal management with planner → executor loop (`loop.ts`)
- Goal state machine: pending → in-progress → done/blocked
- Track progress across restarts via projections

---

## 7. 🛡️ Zero-Trust Security (`src/policy/`, `src/security.ts`)

- Policy-as-Code engine intercepts **every** intent before execution
- Data classification + sandbox profiles
- Destructive actions are simulated first (`src/simulation/`) before being allowed
- Policies viewable/testable via `/policies`, `/policy`, REST `POST /api/v1/policies/evaluate`

---

## 8. 💳 Transactions & Event Sourcing (`src/transaction.ts`, `src/runtime/`)

- Append-only event store guarantees rollback on failure
- Crash recovery: `RuntimeReconciler` rebuilds projections on startup
- Inspect via `/transactions`, `/runtime`, `/events`

---

## 9. 🔬 Simulation Engine (`src/simulation/`)

- Dry-run actions against the world model before committing
- Promote successful simulations to real runs (`POST /api/v1/simulations/:id/promote`)
- CLI: `/simulate`, `/simulations`, `/simulation`

---

## 10. 🌍 World Model (`src/world/`)

- Long-term state modeling of your environment/projects
- Automated drift detection between expected and observed state
- CLI: `/world`

---

## 11. 🩺 Observability (`src/observability/`)

- Metrics, health monitoring per subsystem
- SLO tracking + error budgets (`slo.ts`)
- Cost analysis per interaction (`cost.ts`)
- Bottleneck detection, capacity forecasting, optimization candidates
- Alerts on threshold breaches
- CLI: `/observability`, `/health`, `/diagnostics`

---

## 12. 🌐 Federation (`src/federation/`)

- Secure agent-to-agent delegation across isolated trust domains
- Identity, trust scoring, capability exchange, artifact passing
- Lifecycle management for remote agents
- CLI: `/agents`, `/agent inspect|trust|revoke`

---

## 13. 🧩 Skills System (`src/skills.ts`, `skills/`)

Skills are folders with a `SKILL.md` (YAML frontmatter) auto-discovered at startup:

- **coding** — analyze/modify/debug software projects
- **communication** — writing, tone, messaging
- **productivity** — task/workflow automation
- **system** — OS-level operations
- **terminal** — shell command expertise

Each skill declares its capabilities and required tools; invalid skills fail safely.
CLI: `/skills`, `/skill <name>`

---

## 14. 📚 Memory & Learning (`src/memory.ts`, `src/learning.ts`, `learning/`)

Persistent memory organized into:

- **failures** — what went wrong and why
- **feedback** — user corrections
- **preferences** — how you like things done
- **strategies** — learned approaches that worked

The agent reviews outcomes after tasks and updates its strategies automatically.
CLI: `/memory`, `/learning`, `/preferences`, `/strategies`, `/feedback`

---

## 15. ⏰ Automation (`src/automation.ts`)

- Schedule recurring agent tasks with cron expressions (node-cron)
- Manage via `/automations`, `/automation`

---

## 16. 🧪 Reliability & RCA (`src/reliability/`, `src/rca/`)

- Chaos/fault-injection scenarios run in a lab environment (`injector.ts`, `lab.ts`)
- Invariant checking to catch contract violations
- Root Cause Analysis engine for incidents (`/incidents`, `/root-cause`)
- Dependency graph + impact analysis (`/dependencies`, `/impact`)

---

## 17. 🔌 Extensibility

- **MCP support** (`src/mcp.ts`) — expose/connect Model Context Protocol servers
- **Extensions** (`src/extensions.ts`) — load custom extensions from disk
- CLI: `/mcp`, `/extensions`

---

## 18. 🖥️ Screen Awareness

- Periodic desktop screenshot capture (`screenshot-desktop`) feeding the world model
- Useful for "watch my screen" style automations

---

## 📊 CLI Command Reference

<details>
<summary>Full command list (click to expand)</summary>

```
Voice/Audio   /voice /text /record /stop /mic /devices /voices
Chat          /clear /history /save /config /context /attach /detach /attachments
Sessions      /sessions /session
Tasks         /task /tasks /queue
Goals         /goals /goal
Agents        /agents /agent inspect|trust|revoke
Memory        /memory /learning /preferences /strategies /feedback
Models        /models /providers
Security      /security /policies /policy
Runtime       /transactions /transaction /runtime /events
Simulation    /simulate /simulations /simulation
Ops           /observability /health /diagnostics /trace /last-run
Incidents     /incidents /incident /root-cause /impact /dependencies /reliability
Maintenance   /maintenance
Automation    /automations /automation
Ext           /skills /skill /extensions /mcp /services /connections /capabilities
Output        /debug /verbose /compact /normal
Exit          /exit /quit
```
</details>

---

## 📈 Performance Notes

- Text responses stream in real time
- Live voice: sub-second latency over WebSocket
- All state persisted locally — no cloud lock-in beyond the LLM APIs you configure
