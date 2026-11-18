import { createContext, useState, useEffect } from 'react';
import { socket } from '../services/socket';
import { API_URL, getSession, saveSession, clearSession } from '../services/session';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(getSession);   // { token, username, isGuest } | null

  const login = (token, username) => {
    saveSession({ token, username, isGuest: false });
    setUser(getSession());
  };

  const loginAsGuest = async () => {
    const res = await fetch(`${API_URL}/api/auth/guest`, { method: 'POST' });
    if (!res.ok) throw new Error('guest session failed');
    const { token, username } = await res.json();
    saveSession({ token, username, isGuest: true });
    setUser(getSession());
  };

  const logout = () => { clearSession(); setUser(null); };

  // New identity => new handshake
  useEffect(() => {
    if (!user) { socket.disconnect(); return; }
    socket.disconnect().connect();
  }, [user?.token]);

  // Expired or invalid token: back to /auth
  useEffect(() => {
    const onErr = (err) => { if (err.message === 'unauthorized') logout(); };
    socket.on('connect_error', onErr);
    return () => socket.off('connect_error', onErr);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, loginAsGuest, logout }}>
      {children}
    </AuthContext.Provider>
  );
};