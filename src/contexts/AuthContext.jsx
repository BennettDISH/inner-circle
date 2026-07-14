import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    fetch('/api/auth/config')
      .then(res => (res.ok ? res.json() : { ssoEnabled: false }))
      .then(data => setSsoEnabled(!!data.ssoEnabled))
      .catch(() => setSsoEnabled(false));
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      fetch('/api/auth/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(res => {
          if (res.ok) return res.json();
          throw new Error('Invalid token');
        })
        .then(data => setUser(data.user))
        .catch(() => {
          localStorage.removeItem('token');
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = (token, userData) => {
    localStorage.setItem('token', token);
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
    window.location.href = '/login';
  };

  const ssoLogin = () => {
    // The client_id and auth-service URL are held server-side; we only generate a random
    // state and bounce through our own /sso/login, which builds the authorize URL.
    const state = (window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
    sessionStorage.setItem('sso_state', state);
    window.location.href = `/api/auth/sso/login?state=${state}`;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, ssoLogin, ssoEnabled }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
