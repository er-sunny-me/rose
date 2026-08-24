# 🌹 START HERE

Welcome to **Rose** — a local-first AI agent platform with tools, memory,
automation, research, multi-agent orchestration and Gemini Live voice.

---

## ⚡ 3-Step Setup

### 1️⃣ Get an API key
- Gemini: https://aistudio.google.com/app/apikey (easiest)
- Claude / GPT also supported (see `.env.example`)

### 2️⃣ Create `.env`
```bash
GEMINI_API_KEY=your_api_key_here
```

### 3️⃣ Run
```bash
npm install
npm run dev
```

Headless server + web dashboard instead:
```bash
npm run dev -- --server
```

---

## 💡 First Things to Try

| Type this | You get |
|---|---|
| `hello, what can you do?` | Rose explains its current capabilities |
| `/goal <task>` | Planner breaks it into tasks and executes |
| `/voice` | Real-time voice conversation (Gemini Live) |
| `/memory` | What Rose has learned about you |
| `/skills` | Loaded skill packs |
| `/health` | Live subsystem dashboard |
| `/help` | Every command |

---

## 📖 Documentation Guide

- **QUICK_START.md** → setup + first session walkthrough
- **FEATURES.md** → complete feature list & CLI reference
- **ARCHITECTURE.md** → how the 30-phase engine works
- **SECURITY.md** → zero-trust model explained
- **UPDATES.md** → changelog
- **models.txt** → available Gemini models

---

## 🧭 What Rose Is

Not just a chatbot — a bounded-autonomy agent runtime:

- **Supervisor + 7 specialist agents** (coding, research, security, review, testing, analysis)
- **Zero-trust policy engine** that intercepts and simulates destructive actions
- **Transactions + event store** so crashes never lose state
- **Persistent memory** that learns from failures and your feedback
- **Cron automations**, MCP servers, custom skills/extensions
