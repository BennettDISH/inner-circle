import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { ssoLogin, login, ssoEnabled } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [guestLoading, setGuestLoading] = useState(false);

  const handleGuest = async () => {
    setError('');
    setGuestLoading(true);
    try {
      const res = await fetch('/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start a guest session');
      login(data.token, data.user);
    } catch (err) {
      setError(err.message);
      setGuestLoading(false);
    }
  };

  const handleLocalLogin = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      login(data.token, data.user);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>inner circle</h1>
        <p>A trusted network for sharing what you have and need.</p>
        
        {ssoEnabled && (
          <>
            <button className="btn btn--sso" onClick={ssoLogin}>
              Sign in with Central SSO
            </button>
            <button className="btn" onClick={handleGuest} disabled={guestLoading} style={{ width: '100%', marginTop: '0.5rem' }}>
              {guestLoading ? 'Starting…' : 'Continue as guest'}
            </button>
            <p className="muted" style={{ fontSize: '0.8rem', textAlign: 'center', marginTop: '0.5rem' }}>
              No account needed. Keep it later by adding a username and password.
            </p>

            <div className="divider">
              <span>or use email</span>
            </div>
          </>
        )}

        <form onSubmit={handleLocalLogin}>
          {error && <div className="error-message">{error}</div>}
          <div className="form-group">
            <label>Email</label>
            <input 
              type="email" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              required 
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input 
              type="password" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              required 
            />
          </div>
          <button type="submit" className="btn btn--primary">Sign In</button>
        </form>

        <p className="auth-footer">
          Don't have an account? <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}
