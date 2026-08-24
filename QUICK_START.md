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

Or run the interactive setup wizard:

```bash
npm run dev -- setup
```

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
