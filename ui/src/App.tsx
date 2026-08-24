import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Settings, Plus, Ghost, BarChart2 } from 'lucide-react';
import Overview from './pages/Overview';
import Chat from './pages/Chat';
import SettingsPage from './pages/Settings';
import { checkAuth, getApiToken, setApiToken, hasApiToken } from './api';

const Sidebar = () => {
  const location = useLocation();

  return (
    <div className="sidebar">
      <div className="logo-container">
        <div style={{ padding: '6px', backgroundColor: 'var(--accent-red-bg)', borderRadius: '8px', display: 'flex', alignItems: 'center' }}>
          <Ghost className="logo-icon" size={20} />
        </div>
        <span style={{ fontSize: '1.25rem' }}>Rose</span>
      </div>

      <div className="nav-group">
        <Link to="/" className={`nav-item ${location.pathname === '/' ? 'active' : ''}`}>
          <BarChart2 size={18} style={{ color: location.pathname === '/' ? 'var(--accent-red)' : 'var(--text-secondary)' }} />
          <span>Overview</span>
        </Link>
      </div>

      <div className="nav-group">
        <div className="nav-title">More</div>
        <Link to="/chat" className="nav-item">
          <Plus size={18} className="logo-icon" />
          <span style={{ color: 'var(--text-primary)' }}>New session</span>
        </Link>
      </div>

      <div className="nav-group">
        <div className="nav-title">Sessions</div>
        <Link to="/chat" className={`nav-item ${location.pathname === '/chat' ? 'active' : ''}`}>
          <span style={{ marginLeft: '2px' }}>Main Session</span>
        </Link>
      </div>

      <div style={{ flex: 1 }} />

      <div className="nav-group" style={{ marginBottom: 0 }}>
        <Link to="/settings" className={`nav-item ${location.pathname === '/settings' ? 'active' : ''}`}>
          <Settings size={18} style={{ color: location.pathname === '/settings' ? 'var(--accent-red)' : 'var(--text-secondary)' }} />
          <span>Settings</span>
        </Link>
      </div>
    </div>
  );
};

const Topbar = () => {
  const location = useLocation();
  const path = location.pathname.substring(1) || 'Overview';
  const capitalizedPath = path.charAt(0).toUpperCase() + path.slice(1);

  return (
    <div className="topbar">
      <div className="topbar-breadcrumb">
        <span style={{ color: 'var(--text-muted)' }}>Rose</span>
        <span style={{ color: 'var(--text-muted)' }}>›</span>
        <span>main</span>
        <span style={{ color: 'var(--text-muted)' }}>›</span>
        <span className="active">{capitalizedPath}</span>
      </div>
    </div>
  );
};

/** Phase 34: the API is bearer-protected; gate the panel behind token entry. */
function TokenGate({ onReady }: { onReady: () => void }) {
  const [token, setToken] = useState(getApiToken());
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!hasApiToken()) {
      setError('Enter the API token (see server output or .rose/auth-token).');
      return;
    }
    setChecking(true);
    setError('');
    const ok = await checkAuth();
    setChecking(false);
    if (ok) onReady();
    else setError('Token rejected by the server (401). Double-check it and retry.');
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-secondary, #111)', padding: 24,
    }}>
      <form onSubmit={submit} style={{
        maxWidth: 420, width: '100%', display: 'flex', flexDirection: 'column', gap: 12,
        background: 'var(--bg-primary, #1b1b1f)', padding: 28, borderRadius: 12,
        border: '1px solid var(--border-color, #2c2c33)',
      }}>
        <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>🌹 Rose Control Panel</div>
        <div style={{ opacity: 0.7, fontSize: '0.9rem' }}>
          This dashboard talks to an authenticated API. Paste the access token shown
          when the Agent Server started.
        </div>
        <input
          type="password"
          value={token}
          autoFocus
          placeholder="API access token"
          onChange={(e) => { setToken(e.target.value); setApiToken(e.target.value); }}
          style={{ padding: 10, borderRadius: 8, border: '1px solid var(--border-color, #333)', background: 'transparent', color: 'inherit' }}
        />
        {error && <div style={{ color: '#ff6b6b', fontSize: '0.85rem' }}>{error}</div>}
        <button type="submit" disabled={checking} style={{
          padding: 10, borderRadius: 8, fontWeight: 600,
          background: 'var(--accent-red, #e5484d)', color: 'white', border: 'none',
        }}>
          {checking ? 'Checking…' : 'Unlock dashboard'}
        </button>
      </form>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(hasApiToken() ? null : false);

  useEffect(() => {
    let cancelled = false;
    // If a token is already stored, validate it once on boot.
    (async () => {
      if (!hasApiToken()) return;
      const ok = await checkAuth();
      if (!cancelled) setAuthed(ok);
    })();
    return () => { cancelled = true; };
  }, []);

  if (authed !== true) {
    return <TokenGate onReady={() => setAuthed(true)} />;
  }

  return (
    <BrowserRouter>
      <Sidebar />
      <div className="main-content">
        <Topbar />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}

export default App;
