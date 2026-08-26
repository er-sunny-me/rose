# 🎉 Latest Updates

## Phase 37 — Agent Mesh: PC + Server + Native Android Agents

Rose is now a distributed agent platform. Every device runs its own full Agent
Runtime; the Server only coordinates (identity, pairing, routing, audit) — it
is NOT a god-agent.

- **Mesh Gateway** on the existing Agent Server (`/mesh/ws`): pairing →
  challenge auth → capability exchange → presence → delegation relay → revoke.
- **Pairing**: XXX-XXX human codes (5-min TTL, single-use) + QR payloads
  (`rose-mesh://pair?...`). Unknown devices never auto-trust.
- **Identity & Trust**: stable agentId per device, sha256-hashed device secrets,
  nonce replay-protection, ±30s clock-skew window, instant revocation (4003).
- **Smart routing**: delegations are filtered by required capabilities as a
  HARD requirement; no-capable-agent cases fail honestly to the origin.
- **CLI**: `rose agents list|pair|approve|inspect|revoke|health|task`.
- **Web Panel**: new Agent Mesh page — topology, pair/approve/revoke, live status.
- **Native Android app** (`mobile/`, Kotlin + Jetpack Compose): MeshClient with
  bounded reconnect backoff, Keystore-backed secret storage, Rose-Policy gate
  (OS permission + policy BOTH required), smart local-vs-PC routing with
  battery/Wi-Fi awareness, Material-3 Rose theme, notification channels,
  QR deep-link pairing, offline-first behaviour with UNKNOWN reconciliation.
- Shared language-neutral protocol: `shared/protocol/rose-mesh-protocol.json`.
- Tests: `test-phase37-mesh.ts` — live-gateway E2E (pairing → replay → skew →
  delegation → revoke → reconnect-denied), 19/19 green.

## Phase 36 — `rose tui` Chat (replaces `rose chat`)

Text chat is now a proper full-screen terminal app built on the Rose TUI engine:

- **`rose tui`** opens a scrollable transcript + input; `rose chat` still works as an alias.
- Right-side **MODEL panel** shows what's actually running: provider, model id,
  capability tier (High/Low/Local/Backup), context window in k, live health dot —
  with tools / vision / $-per-Mtok chips when discovery provides them.
- **LAST REPLY panel** names the model that *actually* answered (router fallbacks
  are visible, never hidden), response time, tokens in→out and API-reported cost.
- Streaming replies render token-by-token where the provider supports it.
- Keys: Enter send · ↑↓ scroll history · Ctrl+L clear · Esc quit-confirm · Ctrl+C instant exit.

## Phase 35 — OpenRouter Provider (Aug 2026)

OpenRouter is now a first-class provider inside the existing Model Router — no
new architecture, same circuit-breaker, fallback chain, Security gating and
observability as every other provider.

- `rose setup` → **OpenRouter** section: masked key input, live model discovery
  with context/tools/vision badges, real Test Connection.
- `rose config set agent.provider openrouter` + `keys.openrouter` / env
  `OPENROUTER_API_KEY` (endpoint overridable via `openrouter.baseUrl`).
- Model naming: `openrouter/<vendor>/<model>`.
- Streaming, native tool-call conversion into the existing parser protocol,
  usage + cost accounting, normalized error categories with Retry-After.
- `rose doctor` probes configuration, connectivity, authentication and the
  selected model — keys always masked.
- Tests: `npm run test:phase35` (mocked HTTP, 40 checks) plus an optional live
  integration test (`test-phase35-integration.ts`, runs only with a real key).

## Phase 33 — Premium Setup TUI & Configuration Experience (Aug 2026)

The first-run and configuration experience has been completely rebuilt as a
professional full-screen terminal application.

**Highlights**
- `rose` on a fresh install now launches the **Rose Setup TUI** (alternate-screen,
  keyboard-first, mouse-aware, resize-safe, Ctrl+C always restores your terminal).
- Guided sections: Welcome · AI Provider · Workspace · Memory · Security ·
  Appearance · Web Control · Review · Health Check · Complete.
- **Test Connection** performs real provider probes — results are never faked.
- Appearance with **live preview**: themes (Rose Dark/Light/System), accents,
  density, animations, unicode mode, high contrast.
- Security screen maps directly onto the backend autonomy modes; the Policy
  Engine remains authoritative.
- Web Control Panel config binds to `127.0.0.1` by default with honest port
  availability checks and free-port suggestions.
- Review shows a masked diff before saving; writes are atomic with automatic
  backup + rollback (`Configuration was not changed.` on failure).
- Versioned setup state (`setup.version`) enables future partial migrations.
- `rose setup --reset | --plain | --no-color | --debug`, plus non-TTY guidance.
- `rose doctor` and the TUI health screen share one diagnostic engine.
- Tests: `npm run test:phase33` (40 checks covering validation, transactional
  apply, migration detection, secret masking, port conflicts, render golden tests).

---

# Earlier: Voice-to-Voice Improvements

## ✨ What's New

### 1. 🚀 Auto-Connect Feature
**Before:**
```
You: /voice
🎙️  Voice mode enabled
You: /connect
✅ Connected...
```

**Now:**
```
You: /voice
🎙️  Voice mode enabled (AUDIO responses)
🔌 Auto-connecting to Live API...
✅ Connected to Gemini 3.1 Flash Live Preview!
```

**No need for /connect command anymore!** Just type `/voice` and it automatically connects.

---

### 2. 🎤 Voice Input Ready
Added infrastructure for voice input (microphone):
- `/record` command to start recording
- `/stop` command to stop recording
- Placeholder for future voice input implementation

**Note**: Full microphone implementation coming in next update (requires audio libraries)

---

### 3. ⌨️ Text Mode Toggle
Added `/text` command to switch back from voice mode:
```
You: /text
⌨️  Text mode enabled (TEXT responses)
```

---

### 4. 📊 Improved Status Messages
- Better connection feedback
- Voice mode indicators
- Audio quality information (KB size)
- Helpful tips and suggestions

---

### 5. 🎨 Enhanced UI
- Clearer command descriptions
- Better emoji usage
- More informative messages
- Conversion tips for audio files

---

## 🎯 Current Workflow

### For Text Chat:
```bash
npm start
You: Hello, how are you?
AI: [Text response]
```

### For Voice Chat:
```bash
npm start
You: /voice
# Auto-connects to Live API
You: Tell me a story
AI: [Voice + Text response]
🎵 Voice Response Received!
```

---

## 📝 Updated Commands

### New Commands:
- `/voice` - Enable voice mode (now auto-connects!)
- `/text` - Switch to text-only mode
- `/record` - Start voice recording (coming soon)
- `/stop` - Stop voice recording

### Existing Commands:
- `/voices` - List available voices
- `/config` - Show configuration
- `/clear` - Clear history
- `/history` - View history
- `/save` - Export conversation
- `/help` - Show help
- `/exit` - Quit

---

## 🔧 Technical Changes

### Code Improvements:
1. **Auto-Connection Logic**
   - `/voice` command now triggers automatic connection
   - Returns promise to wait for connection completion
   - Better error handling

2. **Voice Input Infrastructure**
   - Added recording state management
   - Placeholder for microphone input
   - Ready for audio library integration

3. **UI Enhancements**
   - Updated welcome screen
   - Better status indicators
   - More helpful messages

4. **Audio Display**
   - Shows audio size in KB
   - Provides conversion commands
   - Better audio handling feedback

---

## 🚀 How to Use New Features

### Quick Voice Chat:
```
1. npm start
2. /voice         (auto-connects!)
3. Start typing   (AI responds with voice)
4. /save          (export conversation + audio)
```

### Switch Between Modes:
```
/voice    - Enable voice responses
/text     - Enable text-only responses
```

### Change Voice:
```
/voices         - See all options
/voice Charon   - Switch to Charon voice
```

---

## 🎵 Audio Features

### Current:
✅ Voice output (AI speaks)
✅ Multiple voices (5 options)
✅ Audio export (.pcm files)
✅ Auto-connection

### Coming Soon:
🚧 Voice input (microphone)
🚧 Real-time audio playback
🚧 Audio format conversion
🚧 Audio visualization

---

## 💡 Pro Tips

1. **Use /voice once** - It auto-connects, no need for /connect
2. **Check audio size** - Larger responses = more audio data
3. **Save regularly** - Use /save to backup your chats
4. **Convert audio** - Use FFmpeg to convert .pcm to .wav:
   ```bash
   ffmpeg -f s16le -ar 24000 -ac 1 -i audio.pcm audio.wav
   ```

---

## 🐛 Bug Fixes

- ✅ Fixed: Double welcome screen issue
- ✅ Fixed: Connection state management
- ✅ Fixed: Voice mode toggle behavior
- ✅ Improved: Error messages
- ✅ Improved: Connection feedback

---

## 📊 Performance

- Connection time: < 2 seconds
- Voice response: 1-2 seconds
- Audio quality: High-fidelity PCM
- Context window: 8192 tokens

---

## 🔮 Upcoming Features

### Next Update:
1. **Voice Input**
   - Real microphone support
   - Voice recording
   - Audio streaming to API

2. **Audio Playback**
   - Direct terminal playback
   - Volume control
   - Pause/resume

3. **Enhanced UI**
   - Audio waveform visualization
   - Recording indicators
   - Better progress bars

---

## 📚 Documentation Updates

All documentation has been updated:
- ✅ README.md
- ✅ QUICK_START.md
- ✅ FEATURES.md
- ✅ START_HERE.md
- ✅ This file (UPDATES.md)

---

## 🎉 Summary

**Main Improvement**: `/voice` command now **automatically connects** to Live API!

**Before**: 2 commands needed (`/voice` + `/connect`)
**Now**: 1 command (`/voice` does everything!)

**Voice-to-Voice Ready**: Infrastructure in place for microphone input
**Better UX**: Clearer messages, better feedback, easier to use

---

## 🚀 Try It Now!

```bash
npm start
You: /voice
# ✅ Auto-connects!
You: Hello! Tell me about yourself
# 🎵 AI responds with voice + text
```

**That's it! Enjoy your improved voice chat experience! 🎙️🤖**

---

Last Updated: August 23, 2026
Version: 2.0 (Auto-Connect + Voice Input Ready)

---

# 🚀 Phase 34 — Real Capability Upgrade + Architecture Hardening

## Architecture
- **index.ts refactor**: 2455 → ~840 lines. Slash commands moved to 9 modules under `src/cli/commands/` (registry-driven, DI context), voice subsystem extracted to `src/voice/live-session.ts` with an audio state machine.
- **Fixed dead code**: duplicate `/agents` case, unreachable multi-word cases (now a working `/agent inspect|trust|revoke` router), broken `/security mode` parsing; `/simulate` now reaches the pipeline as designed.

## Security
- **Server auth**: every API route requires a bearer token (`.rose/auth-token` or `ROSE_API_TOKEN`, timing-safe compare). `/health` + `/ready` stay public. WebSocket upgrade at `/ws` requires the same token. LAN bindings print a strong warning.
- **Command sandbox** (`src/security/sandbox.ts`): denylist → quote-aware parser → executable allowlist → arg validation → **working-directory jail with symlink/junction resolution** → filtered env (secrets stripped) → timeout + output caps + process-tree kill. `execute_command` supports `dry_run` decision reports. Raw shell `exec` removed from tools.
- **UI login gate**: dashboard asks for the API token once (localStorage).

## Intelligence
- **Vector memory**: Gemini text-embedding-004 provider + local hashed-BOW fallback, JSON vector index with content-hash embedding cache, markdown-aware chunker, **hybrid keyword+vector fusion**, project-scoped isolation, corrupt-index recovery, `/memory index|reindex|status`.
- **Obsidian RAG** (`src/memory/obsidian.ts`): configured-vault ingestion (frontmatter/tags/[[links]] parsed), semantic search over notes, transparent source citations, new `search_obsidian` tool.

## Integrations
- **GitHub**: real REST via Octokit — issues, comments, labels, close, PR list/diff/files, workflow runs. Writes remain policy-gated external actions.
- **Google**: OAuth client shared by Gmail (search/read/draft/send-with-confirmation) and Calendar (list/search/create/delete). Side effects gated by Policy Engine.

## Autonomy & Voice
- **Playwright browser control**: domain allow/deny enforced per-request via routing, downloads off by default, screenshots persisted as artifacts, page content wrapped as UNTRUSTED WEB CONTENT. Optional dependency — degrades cleanly when absent.
- **Full-duplex voice**: deterministic audio state machine (IDLE/LISTENING/THINKING/SPEAKING/INTERRUPTING/PROCESSING_USER/ERROR), server-driven barge-in kills playback instantly and preserves partial transcripts, continuous listening after setup, `/voice stop` teardown, MIC ACTIVE privacy indicator.

## Local models & offline
- **OllamaProvider** plugs into the Model Router registry (health circuit-breaker, model discovery, OpenAI-shaped replies). Offline mode keeps only local providers.

## Quality
- **128 unit tests** (Vitest) across policy engine, capability router, memory, transactions, security redaction/injection, command sandbox (36 cases incl. traversal/symlink/junction), server auth, vector memory, Obsidian RAG, GitHub (mocked API), browser (live local pages), Ollama (offline/mocked).
- **CI** (GitHub Actions): test matrix (Ubuntu/Windows/macOS × Node 20/22), build verification, npm pack + secret scan + clean-dir install smoke test. No auto-publishing.

---

# Phase 36 - Security Hardening + Streaming + Observability + Storage + MCP + Docker

- **Extension signing**: Ed25519 (Node crypto) over canonical payload digest; trusted-publisher registry; revoked keys blocked even with valid signatures; unsigned blocked unless dev-mode. CLI: rose extensions verify|trust|revoke|generate-key.
- **Secure credentials**: SecretStore with DPAPI roundtrip-probe -> AES-256-GCM file fallback; priority store > env > legacy plaintext; rose auth status|set|remove; Model Router reads keys through Secrets.
- **Rate limiting**: express-rate-limit per endpoint class (health/api/chat/admin/ws) + failed-auth lockout with progressive backoff keyed by IP+token-hash; Retry-After on 429.
- **Real update**: npm registry version check (--check / --dry-run / self-update) with semver validation, prerelease guard, exact-version install only.
- **Token streaming**: Gemini SSE / Anthropic SSE / OpenAI+OpenRouter SSE / Ollama JSONL -> ModelRouter.routeStream -> same pipeline for CLI live output and API SSE (stream:true).
- **Observability dashboard**: new Web UI page (health/cost/SLO/performance/capacity/bottleneck widgets); new /api/v1/slo|costs|performance feeds; 5s live polling.
- **Memory consolidation**: duplicate/related clustering -> fast-tier summarization -> ARCHIVE originals with evidence frontmatter; protected types exempt; AutomationHandlers reuse the existing cron engine (ROSE_MEMORY_CONSOLIDATION_CRON).
- **Browser sessions**: opt-in persistence (ROSE_BROWSER_PERSIST) under .rose/browser-sessions with domain scoping + expiry; rose browser sessions|logout|clear.
- **SQLite vectors**: VectorRepository abstraction (JSON default, ROSE_VECTOR_BACKEND=sqlite), better-sqlite3 + sqlite-vec where loadable, JSON->SQLite migration with backup kept, embedding-model version invalidation.
- **MCP server**: rose mcp-server exposes a read-only allowlist (memory search, obsidian search, project status) over stdio; every call passes SecurityEngine/PolicyEngine; audit events in Event Store.
- **Docker**: multi-stage non-root image with HEALTHCHECK (/health) + compose.yaml with localhost-only binding and documented volumes.

Tests: 154 unit tests green (extension tamper/revocation, secrets, lockout progression, update logic, consolidation reversibility, dual-backend vector isolation). Typecheck + build clean. Live checks: rose update --check against registry.npmjs.org OK; server auth 401/200 probes OK.
