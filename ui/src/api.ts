const BASE_URL = 'http://localhost:3000/api/v1';

export const fetchMetrics = async () => {
  const res = await fetch(`${BASE_URL}/metrics`);
  return res.json();
};

export const createSession = async (id: string) => {
  try {
    const res = await fetch(`${BASE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    return await res.json();
  } catch (error) {
    console.error('Failed to create session:', error);
  }
};

export const sendMessage = async (sessionId: string, message: string, modelId: string, onUpdate: (msg: any) => void) => {
  try {
    const response = await fetch(`${BASE_URL}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, modelId })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/event-stream')) {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      
      if (!reader) return;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onUpdate(data);
            } catch (e) {
              console.error('Error parsing SSE data:', e, line);
            }
          }
        }
      }
    } else {
      const data = await response.json();
      onUpdate({ type: 'completion', result: data.message });
    }
  } catch (error) {
    console.error('Failed to send message:', error);
    onUpdate({ type: 'error', message: String(error) });
  }
};

export const fetchHealth = async () => {
  try {
    const res = await fetch(`${BASE_URL}/health/system`);
    return await res.json();
  } catch (error) {
    console.error('Failed to fetch health:', error);
    return null;
  }
};

export const fetchSessions = async () => {
  const res = await fetch(`${BASE_URL}/sessions`);
  return res.json();
};

export const fetchModels = async () => {
  try {
    const res = await fetch(`${BASE_URL}/models`);
    return await res.json();
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return [];
  }
};
