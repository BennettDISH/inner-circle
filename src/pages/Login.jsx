import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { ssoLogin, login, ssoEnabled } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Why the Waypoint return was refused (a guest account), passed on by AuthCallback.
  const [error, setError] = useState(location.state?.refused || '');

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
      navigate('/');
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
              Sign in with Waypoint
            </button>

            <div className="divider">
              <span>or use email</span>
            </div>
          </>
        )}

        <form onSubmit={handleLocalLogin}>
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="form-group">
            <label htmlFor="login-email">Email</label>
            <input 
              id="login-email"
              type="email" 
              autoComplete="email"
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              required 
            />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <input 
              id="login-password"
              type="password" 
              autoComplete="current-password"
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
