import React, { createContext, useContext, useState, useEffect } from 'react';
import { saveSsoReturn } from '../lib/returnPath';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  // Listing photos show up only when the server says its photo storage is set up
  const [photosEnabled, setPhotosEnabled] = useState(false);

  useEffect(() => {
    fetch('/api/auth/config')
      .then(res => (res.ok ? res.json() : { ssoEnabled: false }))
      .then(data => {
        setSsoEnabled(!!data.ssoEnabled);
        setPhotosEnabled(!!data.photos);
      })
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
          // Only a 401 means the token is no good. A server error or a dropped connection keeps
          // it, so the next visit is still signed in.
          if (res.status === 401) localStorage.removeItem('token');
          throw new Error(`Profile answered ${res.status}`);
        })
        .then(data => setUser(data.user))
        .catch(() => setUser(null))
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

  // options.prompt 'login' is "Switch account": Waypoint asks who you are instead of reusing its session.
  const ssoLogin = (returnTo, { prompt } = {}) => {
    // The client_id and auth-service URL are held server-side; we only generate a random
    // state and bounce through our own /sso/login, which builds the authorize URL.
    const state = (window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
    sessionStorage.setItem('sso_state', state);
    saveSsoReturn(returnTo);
    window.location.href = `/api/auth/sso/login?state=${state}${prompt === 'login' ? '&prompt=login' : ''}`;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, ssoLogin, ssoEnabled, photosEnabled }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
