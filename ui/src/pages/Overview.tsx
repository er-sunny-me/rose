import { useEffect, useState } from 'react';
import { fetchHealth } from '../api';

const Overview = () => {
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    fetchHealth().then(setHealth).catch(console.error);
  }, []);

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '8px' }}>Overview</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Status, entry points, health.</p>
      </div>

      <div className="card">
        <div className="card-title">Gateway Access</div>
        <div className="card-subtitle">Where the dashboard connects and how it authenticates.</div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>WebSocket URL</label>
            <input type="text" value="ws://127.0.0.1:3000" readOnly />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px', marginBottom: '24px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Gateway Token</label>
            <input type="password" value="****************" readOnly />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Password (not stored)</label>
            <input type="password" placeholder="system or shared password" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Default Session Key</label>
            <input type="text" value="agent:main:main" readOnly />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Language</label>
            <select>
              <option>English</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="btn btn-outline">Connect</button>
          <button className="btn btn-outline">Refresh</button>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', alignSelf: 'center' }}>Click Connect to apply connection changes.</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Snapshot</div>
        <div className="card-subtitle">Latest gateway handshake information.</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '24px', marginBottom: '24px' }}>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>Status</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#22c55e' }}>
              {health ? 'OK' : 'OFFLINE'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>Uptime</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
              {health?.uptime ? `${Math.floor(health.uptime / 3600)}h` : '0h'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>Tick Interval</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>30s</div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>Last Channels Refresh</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>just now</div>
          </div>
        </div>
        
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.</p>
      </div>
    </div>
  );
};

export default Overview;
