const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('parlance_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function req(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...(options.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  register: (username: string, password: string) =>
    req('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  publishBundle: (bundle: unknown) => req('/keys/bundle', { method: 'POST', body: JSON.stringify(bundle) }),
  getBundle: (username: string) => req(`/keys/bundle/${encodeURIComponent(username)}`),
  listUsers: () => req('/users'),
  listConversations: () => req('/conversations'),
  createConversation: (memberUsernames: string[], isGroup: boolean, name?: string) =>
    req('/conversations', { method: 'POST', body: JSON.stringify({ memberUsernames, isGroup, name }) }),
  getMessages: (conversationId: string) => req(`/conversations/${conversationId}/messages`),
};
