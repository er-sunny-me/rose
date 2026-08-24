# 🚀 Quick Start — Rose AI Agent Platform

## Step 1: Configure Providers

Rose supports **Gemini, Claude, GPT** (direct or via the Antigravity local proxy).
Get at least one API key:

- Gemini: https://aistudio.google.com/app/apikey
- Anthropic: https://console.anthropic.com
- OpenAI: https://platform.openai.com

Copy the example env and fill in your keys:

```bash
cp .env.example .env
```

```bash
# At minimum one of these:
GEMINI_API_KEY=your_gemini_key
ANTHROPIC_API_KEY=your_claude_key     # optional
OPENAI_API_KEY=your_openai_key        # optional
```

Or launch the full-screen setup experience (recommended):

```bash
rose            # first run opens the Rose Setup TUI automatically
rose setup      # reopen it anytime
```

The setup TUI configures provider, model, API key (masked, never displayed),
workspace, memory, security policy, theme and the Web Control Panel — then
runs a real health check before declaring READY. Keys can alternatively come
from `.env` / environment variables; both are detected automatically.

> Non-interactive shells (CI): Rose skips the wizard and prints `rose config`
> instructions instead. Use `rose setup --plain` for a linear fallback flow.

## Step 2: Install & Run

```bash
npm install
npm run dev          # interactive CLI
```

Headless server + web dashboard instead:

```bash
npm run dev -- --server
```

> Dev mode uses `tsx` — no build step needed. For production: `npm run build && npm start`.

## Step 3: Try It Out

Just type a message and press Enter. Useful first commands:

| Command | What it does |
|---------|--------------|
| `/help` | Show all commands |
| `/capabilities` | What this agent can do right now |
| `/voice` | Enable Gemini Live voice mode |
| `/goal <thing>` | Give Rose a long-running goal to plan & execute |
| `/tasks` | See current task queue |
| `/agents` | Multi-agent roster / federation status |
| `/memory` | What Rose remembers about you |
| `/skills` | Loaded skills |
| `/health` | Subsystem health dashboard |

---

## 🎯 Example Session

```
PS ...\Rose> npm run dev

╔══════════════════════════════════════╗
║   🌹 Rose — AI Agent Platform         ║
╚══════════════════════════════════════╝

You: Research the top 3 JS bundlers and write a comparison table

🧠 Supervisor: planning...
   ├─ Research Agent → web_search x3
   ├─ Analysis Agent → summarizing findings
   └─ Coding Agent   → formatting output

🤖 Rose: Here's the comparison of esbuild, Rollup and Vite...

You: /voice
🎙️ Voice mode enabled — connected to Gemini Live!

You: /save
💾 Conversation saved.
```

---

## ⚠️ Troubleshooting

### "API key not found"
- Ensure `.env` exists in the project root with at least one valid key.

### "Connection error" on voice mode
- Check internet connection and Gemini API quota.
- Rose auto-falls back to standard text API if Live is unavailable.

### Voice has no sound
- Install **ffmpeg** (+ ffplay) and make sure it's on PATH — Rose auto-detects it.
- `/devices` lists microphones; `/mic <n>` selects one for `/record`.

### Module not found
```bash
rm -r node_modules package-lock.json
npm install
```

---

## 📚 Learn More

- Features & full CLI reference: `FEATURES.md`
- Architecture: `ARCHITECTURE.md`
- Security model: `SECURITY.md`
- Available models: `models.txt`
