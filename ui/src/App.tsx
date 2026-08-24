import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Settings, Plus, Ghost, BarChart2 } from 'lucide-react';
import Overview from './pages/Overview';
import Chat from './pages/Chat';
import SettingsPage from './pages/Settings';

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

function App() {
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
