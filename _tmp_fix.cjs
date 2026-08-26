// Fix the broken connectTo body in MeshClient.kt
const fs = require('fs');
const f = 'mobile/app/src/main/java/ai/rose/mesh/net/MeshClient.kt';
let s = fs.readFileSync(f, 'utf8');

const lines = s.split('\n');
const startIdx = lines.findIndex(l => l.includes('fun connectTo('));
if (startIdx < 0) { console.error('connectTo not found'); process.exit(1); }
// find closing brace of the function (first line === '    }' after startIdx)
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === '    }') { endIdx = i; break; }
}
if (endIdx < 0) { console.error('end brace not found'); process.exit(1); }

const replacement = [
  '    /** Connect to a server URL from Settings (host:port or full http URL). */',
  '    fun connectTo(serverUrl: String, displayName: String) {',
  '        val cleaned = serverUrl.trim().removeSuffix("/")',
  '        val hostPort = cleaned',
  '            .removePrefix("https://")',
  '            .removePrefix("http://")',
  "            .substringBefore('/')",
  '        this.host = hostPort',
  '        val scheme = if (cleaned.startsWith("https://")) "wss" else "ws"',
  '        connect("$scheme://$hostPort/mesh/ws?token=mesh.$deviceId", displayName)',
  '    }',
];
lines.splice(startIdx, endIdx - startIdx + 1, ...replacement);
fs.writeFileSync(f, lines.join('\n'));
console.log('connectTo fixed');
