import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

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
    const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
    const authUrl = import.meta.env.VITE_AUTH_SERVICE_URL;
    const redirectUri = encodeURIComponent(`${window.location.origin}/auth/callback`);
    window.location.href = `${authUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code`;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, ssoLogin }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
