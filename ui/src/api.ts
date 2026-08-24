// Phase 33: follow whatever origin the panel is served from so the
// configured host/port in `rose setup` just works.
const BASE_URL = `${(typeof window !== 'undefined' && window.location?.origin) || 'http://127.0.0.1:3000'}/api/v1`;

// Phase 34: the API requires bearer auth. The dashboard asks once for the
// token (printed by the server / stored in .rose/auth-token) and keeps it in
// localStorage. It is never logged and never embedded in the bundle.
const TOKEN_KEY = 'rose.api-token';

export function getApiToken(): string {
  return (typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_KEY)) || '';
}

export function setApiToken(token: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token.trim());
  }
}

export function hasApiToken(): boolean {
  return getApiToken().length >= 32;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getApiToken();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: authHeaders() });
    if (res.status === 401 || res.status === 403) return false;
    return res.ok;
  } catch {
    return false;
  }
}

async function parseOrThrow(res: Response) {
  if (res.status === 401 || res.status === 403) {
    const err = new Error('UNAUTHORIZED');
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

export const fetchMetrics = async () => {
  const res = await fetch(`${BASE_URL}/metrics`, { headers: authHeaders() });
  return parseOrThrow(res);
};

export const createSession = async (id: string) => {
  try {
    const res = await fetch(`${BASE_URL}/sessions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id })
    });
    return await parseOrThrow(res);
  } catch (error) {
    console.error('Failed to create session:', error);
  }
};

export const sendMessage = async (sessionId: string, message: string, modelId: string, onUpdate: (msg: any) => void) => {
  try {
    const response = await fetch(`${BASE_URL}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
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
    const res = await fetch(`${BASE_URL}/health/system`, { headers: authHeaders() });
    return await parseOrThrow(res);
  } catch (error) {
    console.error('Failed to fetch health:', error);
    return null;
  }
};

export const fetchSessions = async () => {
  const res = await fetch(`${BASE_URL}/sessions`, { headers: authHeaders() });
  return parseOrThrow(res);
};

export const fetchModels = async () => {
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: authHeaders() });
    return await parseOrThrow(res);
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return [];
  }
};
