# 🌐 Rose Agent Mesh

Rose devices form a **secure mesh**: every device runs its own full Agent
Runtime; the Server only does identity, pairing, routing, coordination,
transport and audit. The server is **not** a giant agent core.

```
        PC AGENT                MOBILE AGENT
   (full runtime)            (mobile runtime: camera/
        │                     mic/notifications/local
        │                     memory + delegation)
        └────────┬───────────────┘
           ROSE SERVER  ← /mesh/ws gateway on the SAME Agent Server
                 │
          OTHER ROSE AGENTS (Linux / Docker / macOS)
```

## Components shipped

| Piece | Where | What it does |
|---|---|---|
| Protocol v1 | `shared/protocol/rose-mesh-protocol.json` | Versioned message contracts consumed by TypeScript **and** Kotlin |
| Pairing | `src/mesh/pairing.ts` | XXX-XXX human codes (5-min TTL, single-use) + QR payload (`rose-mesh://pair?host=…&token=…`) |
| Device Registry | `src/mesh/pairing.ts` (`DeviceRegistry`) | agentId/deviceId/platform/trust/capabilities, secret stored as SHA-256 hash only |
| Gateway | `src/mesh/gateway.ts` | WebSocket at `/mesh/ws` on the existing Agent Server: hello → challenge → capability exchange → presence → delegation relay → revoke |
| REST API | `src/server.ts` | `POST /agents/pair`, `POST /agents/pair/approve`, `GET /agents`, `GET /agents/:id`, `GET /agents/:id/health`, `POST /agents/:id/revoke`, `POST /agents/:id/tasks`, `GET /mesh` |
| CLI | `rose agents list\|pair\|approve\|inspect\|revoke\|health\|task` | Console-side mesh control |
| Web Panel | `/mesh` page in the Control Panel | Topology + pair/approve/revoke UI |
| Mobile Agent | `mobile/` | Native Kotlin + Jetpack Compose Android app |

## Security model

1. **Pairing is human-approved.** A device with just the QR/token cannot join —
   a trusted console must approve the code while it is still valid.
2. **deviceSecret is delivered exactly once**, over the encrypted pairing
   connection, and stored hashed (SHA-256) on the server, Keystore-encrypted on
   Android.
3. **Challenge auth** on every reconnect: server sends a random challenge;
   device replies with `sha256(challenge:sha256(secret))`.
4. **Replay protection:** nonce cache per connection; reused nonce ⇒ error REPLAY.
5. **Clock skew:** timestamps outside ±30s of server time are rejected.
6. **Revocation** instantly blocks reconnection (4003); the phone must be
   re-paired by a human.
7. **Capability routing is a hard filter:** a task requiring `terminal` will
   never land on an agent that lacks it, even if that agent is the only one online.

## Quick start (two devices)

```bash
# On the PC (server side)
rose web                      # starts Agent Server + mesh gateway
rose agents pair              # prints code + QR payload

# Approve when the phone attempts to connect
rose agents approve 482-921   # or approve from the Web Panel

# On another machine / Docker agent
ROSE_SERVER=http://pc-ip:3000 rose agents pair
```

## Tests

```bash
npx tsx test-phase37-mesh.ts   # live-gateway E2E: pairing→auth→replay→delegate→revoke
npm run test:e2e               # platform regression
```
