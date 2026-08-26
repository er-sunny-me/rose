# 🚀 Rose Agent SERVER — deploy package

Standalone, cloud-ready deployment for the Rose **Agent Server** (REST + Web +
`/mesh/ws` Agent Mesh gateway). The agent runtime stays on your devices; this
box coordinates the mesh.

```
server/
├── Dockerfile          # production image (non-root, healthcheck, ROSE_HOME volume)
├── docker-compose.yml  # one-command up (+ optional auto-HTTPS via Caddy)
├── .env.example        # required token + provider keys
├── Caddyfile           # TLS reverse proxy (Let's Encrypt)
└── deploy-aws.sh       # instant single-instance EC2 deploy
```

## ⚡ AWS — fastest paths

### Option A: EC2 one-shot (recommended first deploy)

```bash
cd server
chmod +x deploy-aws.sh
./deploy-aws.sh --key-name my-keypair --repo <your-git-url>
# prints IP; token: ssh ec2-user@<ip> "sudo cat /root/rose-api-token"
```

### Option B: Any host with Docker (Lightsail/VPS/EC2 manual)

```bash
git clone <repo> && cd Rose/server
printf 'ROSE_API_TOKEN=%s\n' "$(openssl rand -base64 32)" > .env
docker compose up -d --build
curl -s localhost:3000/health && echo OK
```

### Option C: HTTPS in front

```bash
DOMAIN=mesh.example.com ACME_EMAIL=you@x.com \
ROSE_BIND=0.0.0.0 docker compose --profile tls up -d
# clients then use https://mesh.example.com with Bearer token
```

## Connecting clients

```bash
# On any machine:
export ROSE_API_TOKEN=<token-from-server>
rose config set web.host <server-ip>     # optional convenience
rose agents pair                          # pairing codes flow through this server
curl -H "Authorization: Bearer $TOKEN" http://<ip>:3000/api/v1/mesh
```

Mesh WebSocket: `wss://<host>/mesh/ws?token=…` (mobile app scans the QR from
the PC — same host/token).

## Production checklist

- [x] Non-root container user, read-only code, writable `/data`
- [x] Healthcheck wired (`/health`) — ALB/target-group ready
- [x] Token auth mandatory beyond localhost; rate limiting + lockout active
- [x] Replay protection & clock-skew window on mesh messages
- [ ] TLS terminated at Caddy profile **or** an AWS ALB with ACM cert
- [ ] Security group: keep `3000` closed if using the TLS edge
- [ ] Back up the `rose-config` volume (contains config.json + device registry)
