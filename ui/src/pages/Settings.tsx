import { useState } from 'react';

const SettingsPage = () => {
  const [activeTab, setActiveTab] = useState('settings');
  const [isAdvanced, setIsAdvanced] = useState(false);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '8px', color: 'var(--accent-red)' }}>Settings</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Edit openclaw.json.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', backgroundColor: '#151b21', padding: '4px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
          <button 
            className="btn" 
            onClick={() => setIsAdvanced(false)}
            style={{ padding: '6px 16px', borderRadius: '6px', color: !isAdvanced ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >Simple</button>
          <button 
            className="btn" 
            onClick={() => setIsAdvanced(true)}
            style={{ padding: '6px 16px', borderRadius: '6px', color: isAdvanced ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >Advanced</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', overflowX: 'auto', paddingBottom: '8px' }}>
        {['settings', 'channels', 'communications', 'appearance', 'automation', 'mcp', 'infrastructure'].map((tab) => (
          <button 
            key={tab}
            className={`btn ${activeTab === tab ? '' : 'btn-outline'}`}
            onClick={() => setActiveTab(tab)}
            style={{ 
              border: activeTab === tab ? '1px solid var(--border-color)' : 'none',
              backgroundColor: activeTab === tab ? 'rgba(255,255,255,0.05)' : 'transparent',
              textTransform: 'capitalize'
            }}
          >
            {tab === 'settings' ? '⚙️ Settings' : 
             tab === 'channels' ? '🔗 Channels' :
             tab === 'communications' ? '🚀 Communications' :
             tab === 'appearance' ? '✨ Appearance' :
             tab === 'automation' ? '› Automation' :
             tab === 'mcp' ? '⚙ MCP' :
             tab === 'infrastructure' ? '🌐 Infrastructure' : tab}
          </button>
        ))}
      </div>

      {activeTab === 'settings' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '24px', marginBottom: '24px' }}>
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-title" style={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}>
              <span>Model & Thinking</span>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '0.9rem' }}>Model</span>
              <span style={{ color: 'var(--accent-red)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '4px' }}>default ›</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '0.9rem' }}>Thinking</span>
              <div style={{ display: 'flex', gap: '16px', fontSize: '0.9rem' }}>
                <span>Off</span>
                <span style={{ color: 'var(--text-secondary)' }}>Low</span>
                <span style={{ color: 'var(--text-secondary)' }}>Medium</span>
                <span style={{ color: 'var(--text-secondary)' }}>High</span>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.9rem' }}>Fast mode</span>
              <div style={{ display: 'flex', gap: '16px', fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Auto</span>
                <span style={{ color: 'var(--text-secondary)' }}>Fast</span>
                <span style={{ border: '1px solid var(--border-color)', padding: '4px 12px', borderRadius: '16px' }}>Standard</span>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-title" style={{ fontSize: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <span>Channels</span>
              <span style={{ fontSize: '0.75rem', color: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.1)', padding: '4px 8px', borderRadius: '4px' }}>1 Connected</span>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div className="status-indicator"></div> Telegram
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Configured</span>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 0 }}>
            <div className="card-title" style={{ fontSize: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <span>Security</span>
              <span style={{ color: 'var(--accent-red)', fontSize: '0.85rem' }}>Configure →</span>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '0.9rem' }}>Gateway auth</span>
              <span style={{ fontSize: '0.75rem', color: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.1)', padding: '2px 8px', borderRadius: '12px' }}>Token</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '0.9rem' }}>Exec policy</span>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Allowlist</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '0.9rem' }}>Browser enabled</span>
              <div style={{ width: '40px', height: '20px', backgroundColor: 'var(--accent-red)', borderRadius: '10px', position: 'relative' }}>
                <div style={{ width: '16px', height: '16px', backgroundColor: 'white', borderRadius: '50%', position: 'absolute', top: '2px', right: '2px' }}></div>
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <span style={{ fontSize: '0.9rem', display: 'block', marginBottom: '8px' }}>Tool profile</span>
              <div style={{ display: 'flex', gap: '8px', fontSize: '0.85rem' }}>
                <span style={{ color: 'var(--text-secondary)', flex: 1, textAlign: 'center' }}>minimal</span>
                <span style={{ backgroundColor: '#1e262e', border: '1px solid rgba(255,255,255,0.1)', flex: 1, textAlign: 'center', padding: '4px', borderRadius: '4px' }}>coding</span>
                <span style={{ color: 'var(--text-secondary)', flex: 1, textAlign: 'center' }}>messaging</span>
                <span style={{ color: 'var(--text-secondary)', flex: 1, textAlign: 'center' }}>full</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'appearance' && (
        <div className="card">
          <div className="card-title" style={{ fontSize: '1rem', marginBottom: '24px' }}>Appearance</div>
          
          <div style={{ display: 'flex', gap: '48px', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>Theme</div>
              <div style={{ display: 'flex', backgroundColor: '#1a1f26', borderRadius: '8px', padding: '4px' }}>
                <button className="btn" style={{ padding: '6px 16px', backgroundColor: '#2a323d', borderRadius: '6px' }}>Claw</button>
                <button className="btn" style={{ padding: '6px 16px', color: 'var(--text-secondary)' }}>Knot</button>
                <button className="btn" style={{ padding: '6px 16px', color: 'var(--text-secondary)' }}>Dash</button>
                <button className="btn" style={{ padding: '6px 16px', color: 'var(--text-secondary)' }}>Import</button>
              </div>
            </div>
            
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>Mode</div>
              <div style={{ display: 'flex', backgroundColor: '#1a1f26', borderRadius: '8px', padding: '4px' }}>
                <button className="btn" style={{ padding: '6px 16px', color: 'var(--text-secondary)' }}>Light</button>
                <button className="btn" style={{ padding: '6px 16px', backgroundColor: '#2a323d', borderRadius: '6px' }}>Dark</button>
                <button className="btn" style={{ padding: '6px 16px', color: 'var(--text-secondary)' }}>System</button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {activeTab !== 'settings' && activeTab !== 'appearance' && (
        <div className="card" style={{ minHeight: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
          <div>{activeTab} configuration coming soon.</div>
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
