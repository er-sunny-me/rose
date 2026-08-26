import { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, QrCode, Ban, Activity } from 'lucide-react';
import { getApiToken } from '../api';

interface MeshAgent {
  agentId: string;
  deviceId: string;
  displayName: string;
  platform: string;
  trust: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'degraded';
  lastSeen?: number;
}

interface MeshSummary {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  agents: MeshAgent[];
}

const API = '/api/v1';

async function call(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiToken()}` },
  });
  return res.json();
}

function statusDot(status: string): { color: string; label: string } {
  if (status === 'online') return { color: '#3dd68c', label: 'Online' };
  if (status === 'degraded') return { color: '#f5a623', label: 'Degraded' };
  return { color: '#6b7280', label: 'Offline' };
}

export default function Mesh() {
  const [summary, setSummary] = useState<MeshSummary | null>(null);
  const [pairing, setPairing] = useState<{ code: string; qr: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const s = await call('/mesh');
    if (s && typeof s.total === 'number') setSummary(s);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const startPairing = async () => {
    setBusy(true);
    const p = await call('/agents/pair', { method: 'POST' });
    setBusy(false);
    if (p?.code) setPairing(p);
  };

  const approve = async (code: string) => {
    await call('/agents/pair/approve', { method: 'POST', body: JSON.stringify({ code }) });
    setTimeout(refresh, 800);
  };

  const revoke = async (agentId: string) => {
    await call(`/agents/${encodeURIComponent(agentId)}/revoke`, { method: 'POST' });
    void refresh();
  };

  return (
    <div style={{ padding: 20, color: 'inherit' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Users size={22} />
        <h2 style={{ margin: 0 }}>Agent Mesh</h2>
        <button onClick={refresh} style={btnGhost}><RefreshCw size={14} /> Refresh</button>
        <button onClick={startPairing} disabled={busy} style={{ ...btnPrimary, marginLeft: 'auto' }}>
          <QrCode size={14} /> Pair new Agent
        </button>
      </div>

      {pairing && (
        <div style={card('#2b1d1d')}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>🤝 Pairing request open</div>
          <div>Code: <span style={{ fontFamily: 'monospace', fontSize: '1.4rem' }}>{pairing.code}</span></div>
          <div style={{ opacity: 0.7, fontSize: '0.85rem', wordBreak: 'break-all', marginTop: 4 }}>
            QR payload: {pairing.qr}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={() => approve(pairing.code)} style={btnPrimary}>Approve device</button>
            <button onClick={() => setPairing(null)} style={btnGhost}>Dismiss</button>
          </div>
        </div>
      )}

      {summary ? (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <Stat label="Total" value={summary.total} />
            <Stat label="Online" value={summary.online} color="#3dd68c" />
            <Stat label="Degraded" value={summary.degraded} color="#f5a623" />
            <Stat label="Offline" value={summary.offline} color="#6b7280" />
          </div>

          <div style={{ ...card(), marginBottom: 16 }}>
            <div style={{ opacity: 0.65, fontSize: '0.8rem', letterSpacing: 1 }}>TOPOLOGY</div>
            <pre style={{ margin: '8px 0 0', fontFamily: 'ui-monospace, monospace', lineHeight: 1.5 }}>
{`        ROSE SERVER
             │
     ┌───────┴────────┐
${(summary.agents || []).map(a => `     ● ${a.displayName.padEnd(14)} (${a.platform})`).join('\n')}`}
            </pre>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                <th style={th}>Agent</th><th style={th}>Platform</th><th style={th}>Status</th>
                <th style={th}>Trust</th><th style={th}>Capabilities</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {(summary.agents || []).map(a => {
                const dot = statusDot(a.status);
                return (
                  <tr key={a.agentId} style={{ borderTop: '1px solid rgba(128,128,128,.25)' }}>
                    <td style={td}><strong>{a.displayName}</strong><div style={{ opacity: .5, fontSize: '.75rem' }}>{a.agentId}</div></td>
                    <td style={td}>{a.platform}</td>
                    <td style={td}><span style={{ color: dot.color }}>●</span> {dot.label}</td>
                    <td style={td}>{a.trust}</td>
                    <td style={{ ...td, fontSize: '.8rem', opacity: .8 }}>{a.capabilities?.join(', ')}</td>
                    <td style={td}>
                      {a.trust !== 'revoked' && (
                        <button onClick={() => revoke(a.agentId)} style={btnGhost} title="Revoke device">
                          <Ban size={13} /> Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(summary.agents || []).length === 0 && (
            <div style={{ opacity: .6, padding: 24, textAlign: 'center' }}>
              No agents paired yet. Click “Pair new Agent”, then run <code>rose agents pair</code> on the other device
              or connect the mobile app with the QR payload.
            </div>
          )}
        </>
      ) : (
        <Activity style={{ opacity: .4 }} />
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '10px' };

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ flex: 1, background: 'rgba(128,128,128,.08)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ opacity: .6, fontSize: '.8rem' }}>{label}</div>
    </div>
  );
}

function card(bg?: string): React.CSSProperties {
  return {
    background: bg ?? 'rgba(128,128,128,.06)',
    border: '1px solid rgba(128,128,128,.2)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  };
}

const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'var(--accent-red, #e5484d)', color: '#fff',
  padding: '8px 14px', borderRadius: 8, border: 'none', fontWeight: 600,
};
const btnGhost: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'transparent', color: 'inherit',
  padding: '8px 12px', borderRadius: 8,
  border: '1px solid rgba(128,128,128,.35)',
};
