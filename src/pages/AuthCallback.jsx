import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const code = searchParams.get('code');
    if (!code) {
      setError('No code provided from SSO');
      return;
    }

    fetch('/api/auth/sso-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
      .then(res => {
        if (!res.ok) return res.json().then(e => { throw new Error(e.error || 'Failed to exchange code'); });
        return res.json();
      })
      .then(data => {
        login(data.token, data.user);
        navigate('/');
      })
      .catch(err => {
        console.error('SSO Error:', err);
        setError(err.message);
      });
  }, [searchParams, login, navigate]);

  if (error) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Authentication Error</h2>
          <p className="error-message">{error}</p>
          <button className="btn btn--primary" onClick={() => navigate('/login')}>Back to Login</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h2>Connecting to SSO...</h2>
        <div className="spinner"></div>
      </div>
    </div>
  );
}
