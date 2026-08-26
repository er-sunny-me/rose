# 🖥️ Remote Agents

Any machine that runs Rose can join the mesh: Windows, Linux, macOS, Docker.

## Join from Linux/Docker

```bash
npm i -g rose-ai
rose setup                       # once
ROSE_SERVER=http://<pc-ip>:3000 rose web   # LAN mode: explicit host binding
rose agents pair                 # prints code; approve on your main console
```

In Docker, publish port 3000 and set `web.host=0.0.0.0` explicitly — the
default stays localhost-only by design.

## Capabilities

Advertise what the box actually has:

| Platform | Typical caps |
|---|---|
| Windows PC | terminal, filesystem, browser, model |
| Linux server | terminal, filesystem, research, network |
| Docker | terminal, network, research |
| macOS | terminal, filesystem, browser |
| Android | camera, microphone, notifications |

The gateway routes delegations strictly by capability + trust + online state;
a missing capability means an honest failure result back to the origin, never a
silent misroute.

## Failure semantics

- Target offline at delegate-time → immediate `failed` result ("no capable
  trusted agent").
- Connection lost mid-task → task becomes **UNKNOWN**; origin reconciles by
  querying before any retry. Actions are never duplicated blindly.
