import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from './api';
import { ensureKeysPublished } from './crypto/signal';
import { connectSocket } from './socket';

interface AuthState {
  userId: string;
  username: string;
  token: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadStored(): AuthState | null {
  const token = localStorage.getItem('parlance_token');
  const userId = localStorage.getItem('parlance_userId');
  const username = localStorage.getItem('parlance_username');
  if (token && userId && username) return { token, userId, username };
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(loadStored());

  async function persistAndConnect(result: { token: string; userId: string; username: string }) {
    localStorage.setItem('parlance_token', result.token);
    localStorage.setItem('parlance_userId', result.userId);
    localStorage.setItem('parlance_username', result.username);
    setAuth(result);
    await ensureKeysPublished(result.userId);
    connectSocket(result.token);
  }

  async function login(username: string, password: string) {
    const result = await api.login(username, password);
    await persistAndConnect(result);
  }

  async function register(username: string, password: string) {
    const result = await api.register(username, password);
    await persistAndConnect(result);
  }

  function logout() {
    localStorage.removeItem('parlance_token');
    localStorage.removeItem('parlance_userId');
    localStorage.removeItem('parlance_username');
    setAuth(null);
  }

  return <AuthContext.Provider value={{ auth, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
