import { useState, useRef, useEffect } from 'react';
import { Mic, Settings } from 'lucide-react';
import { sendMessage, fetchModels } from '../api';

const Chat = () => {
  const [messages, setMessages] = useState<{ role: string, content: string }[]>([]);
  const [input, setInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId] = useState('main'); // Hardcoded for now based on Rose structure
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [activeModelName, setActiveModelName] = useState('Loading...');
  const [activeModelId, setActiveModelId] = useState('');
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    import('../api').then(({ createSession }) => {
      createSession(sessionId).catch(console.error);
    });
    fetchModels().then(models => {
      setAvailableModels(models);
      if (models.length > 0) {
        setActiveModelName(models[0].name);
        setActiveModelId(models[0].id);
      } else {
        setActiveModelName('No models found');
      }
    });
  }, [sessionId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim()) return;

    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');

    // Add empty placeholder for assistant message
    setMessages(prev => [...prev, { role: 'assistant', content: '...' }]);

    await sendMessage(sessionId, input, activeModelId, (data) => {
      setMessages(prev => {
        const newMsgs = [...prev];
        const last = newMsgs[newMsgs.length - 1];
        
        if (data.type === 'completion') {
          last.content = data.result || 'Done.';
        } else if (data.type === 'error') {
          last.content = `Error: ${data.message}`;
        } else if (data.type === 'task_update' || data.type === 'orchestration_update' || data.type === 'research_update') {
          // If the message is just '...', clear it before appending
          if (last.content === '...') last.content = '';
          last.content += `[${data.status}] ${data.msg}\n`;
        }
        
        return newMsgs;
      });
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 100px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        
        {messages.length === 0 ? (
          <div style={{ marginTop: '100px', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'fadeIn 0.5s ease' }}>
            <div style={{ width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'var(--accent-red-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', boxShadow: '0 0 20px rgba(239, 68, 68, 0.15)' }}>
              <div style={{ fontSize: '32px' }}>🌹</div>
            </div>
            <h1 style={{ fontSize: '1.75rem', marginBottom: '16px', fontWeight: 600, letterSpacing: '-0.02em' }}>Rose</h1>
            <div style={{ padding: '6px 16px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '32px', backgroundColor: 'rgba(255,255,255,0.02)', fontWeight: 500 }}>
              Ready to chat
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '24px' }}>Type a message below · / for commands</p>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', width: '100%', maxWidth: '600px' }}>
              <button className="btn btn-outline" style={{ justifyContent: 'center', padding: '14px 16px' }}>What can you do?</button>
              <button className="btn btn-outline" style={{ justifyContent: 'center', padding: '14px 16px' }}>Summarize my recent sessions</button>
              <button className="btn btn-outline" style={{ justifyContent: 'center', padding: '14px 16px' }}>Help me configure a channel</button>
              <button className="btn btn-outline" style={{ justifyContent: 'center', padding: '14px 16px' }}>Check system health</button>
            </div>
          </div>
        ) : (
          <div style={{ width: '100%', maxWidth: '800px', margin: '0 auto' }}>
            {messages.map((msg, idx) => (
              <div key={idx} style={{ 
                marginBottom: '24px', 
                display: 'flex', 
                flexDirection: 'row',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                alignItems: 'flex-start',
                gap: '12px'
              }}>
                {msg.role === 'assistant' && (
                  <div style={{ width: '32px', height: '32px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0, marginTop: '4px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                    <img src="/favicon.png" alt="Rose" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                )}
                
                <div style={{ 
                  maxWidth: '85%', 
                  padding: msg.role === 'user' ? '12px 18px' : '6px 0', 
                  borderRadius: msg.role === 'user' ? '16px' : '0',
                  backgroundColor: msg.role === 'user' ? '#1e262e' : 'transparent',
                  border: msg.role === 'user' ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  lineHeight: '1.5'
                }}>
                  {msg.content === '...' ? (
                    <div style={{ display: 'flex', alignItems: 'center', height: '24px' }}>
                      <span className="thinking-dot"></span>
                      <span className="thinking-dot"></span>
                      <span className="thinking-dot"></span>
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '24px', background: 'linear-gradient(transparent, var(--bg-main) 30%)', display: 'flex', justifyContent: 'center' }}>
        <form onSubmit={handleSend} className="chat-input-wrapper" style={{ width: '100%', maxWidth: '800px' }}>
          <button type="button" className="btn" style={{ color: 'var(--text-muted)' }}><Settings size={18} /></button>
          <input 
            type="text" 
            value={input} 
            onChange={(e) => setInput(e.target.value)} 
            placeholder="Message Rose" 
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', boxShadow: 'none' }} 
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingRight: '4px', position: 'relative' }}>
            <button 
              type="button" 
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', outline: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {activeModelName}
            </button>
            
            {showModelDropdown && availableModels.length > 0 && (
              <div className="model-dropdown" style={{ minWidth: '280px', padding: '6px', gap: '2px', bottom: 'calc(100% + 12px)' }}>
                <div style={{ padding: '8px 12px', fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.02em' }}>Model</div>
                {availableModels.map(model => (
                  <div 
                    key={model.id}
                    className={`model-dropdown-item-wrapper`}
                    style={{ position: 'relative' }}
                    onMouseEnter={() => setHoveredModelId(model.id)}
                    onMouseLeave={() => setHoveredModelId(null)}
                  >
                    <button 
                      type="button"
                      className={`model-dropdown-item ${activeModelId === model.id ? 'active' : ''}`}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', width: '100%' }}
                      onClick={() => { 
                        setActiveModelName(model.name); 
                        setActiveModelId(model.id); 
                        setShowModelDropdown(false); 
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '0.9rem' }}>{model.name}</span>
                        {model.tier && (
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                            {model.tier}
                          </span>
                        )}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {model.badge && (
                          <span style={{ 
                            padding: '2px 8px', 
                            borderRadius: '12px', 
                            backgroundColor: 'rgba(255,255,255,0.06)', 
                            color: 'var(--text-secondary)', 
                            fontSize: '0.75rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                          }}>
                            {model.badge}
                            {model.badge === 'Fast' && <span style={{ fontSize: '0.7rem', opacity: 0.7, border: '1px solid currentColor', borderRadius: '50%', width: '12px', height: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>i</span>}
                          </span>
                        )}
                        <span style={{ color: 'var(--text-secondary)', opacity: 0.5, fontSize: '0.9rem' }}>›</span>
                      </span>
                    </button>
                    
                    {/* Submenu for Medium/High/Low if hover */}
                    {hoveredModelId === model.id && (
                      <div className="model-dropdown-submenu" style={{
                        position: 'absolute',
                        right: '100%',
                        top: '-10px',
                        marginRight: '4px',
                        backgroundColor: 'rgba(26, 31, 36, 0.9)',
                        backdropFilter: 'blur(20px)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '12px',
                        padding: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        minWidth: '120px',
                        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                        zIndex: 60
                      }}>
                        {['Low', 'Medium', 'High'].map(level => (
                          <button
                            key={level}
                            type="button"
                            className={`model-dropdown-item ${model.tier === level ? 'active-tier' : ''}`}
                            style={{ 
                              textAlign: 'left', 
                              padding: '8px 12px',
                              backgroundColor: model.tier === level ? 'rgba(255,255,255,0.1)' : 'transparent',
                              color: model.tier === level ? 'white' : 'var(--text-secondary)',
                              border: 'none',
                              borderRadius: '8px',
                              cursor: 'pointer'
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveModelName(`${model.name}`);
                              setActiveModelId(model.id);
                              setShowModelDropdown(false);
                            }}
                          >
                            {level}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            
            <button 
              type="button" 
              onClick={() => setIsRecording(!isRecording)}
              className="btn btn-primary" 
              style={{ 
                borderRadius: '50%', 
                width: '36px', 
                height: '36px', 
                padding: 0, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                animation: isRecording ? 'pulse 1.5s infinite' : 'none'
              }}
            >
              <Mic size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Chat;
