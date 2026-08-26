# 🤝 Pairing Guide

Pairing connects a new device (phone / PC / server) to your Agent Mesh.

## Flow

```
New device            Trusted console (PC/Web)          Server
    │  rose agents pair  ──────────────▶  code XXX-XXX + QR
    │  connect with QR token ──────────────────────────▶  hello
    │                                     ◀── "device wants to connect"
    │                            user clicks Approve
    │  ◀═══ agentId + one-time deviceSecret ═══
    │  trusted ✔  (challenge auth from now on)
```

## Rules the server enforces

- Codes expire after **5 minutes** and are **single-use**.
- The QR payload carries only `host` + short-lived `token` — never API keys.
- An unapproved token is rejected at hello (`mobile.pair.rejected`).
- A revoked device is refused on reconnect (close code 4003) until a human
  re-pairs it.

## Commands

```bash
rose agents pair            # begin pairing; prints code + QR payload
rose agents approve <code>  # approve from the trusted console
rose agents list            # show mesh with trust/status
rose agents inspect <id>    # full detail for one agent
rose agents revoke <id>     # permanently untrust a device
```

Web Control Panel → **Agent Mesh** supports the same actions with buttons.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `mobile.pair.rejected` | token expired/used/not approved | generate a fresh code, then approve |
| close 4003 on reconnect | device revoked | re-pair from scratch |
| REPLAY error in debug | nonce reuse | update the client — nonces must be unique |
| CLOCK_SKEW error | device clock off by >30s | sync device time |
