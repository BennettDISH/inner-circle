import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Register() {
  const { login } = useAuth();
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    first_name: '',
    last_name: ''
  });
  const [error, setError] = useState('');

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      login(data.token, data.user);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Join the Circle</h1>
        <p>Register to start sharing with your trusted network.</p>

        <form onSubmit={handleSubmit}>
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="register-first-name">First Name</label>
              <input id="register-first-name" name="first_name" autoComplete="given-name" value={formData.first_name} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label htmlFor="register-last-name">Last Name</label>
              <input id="register-last-name" name="last_name" autoComplete="family-name" value={formData.last_name} onChange={handleChange} required />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="register-username">Username</label>
            <input id="register-username" name="username" autoComplete="username" value={formData.username} onChange={handleChange} required />
          </div>
          <div className="form-group">
            <label htmlFor="register-email">Email</label>
            <input id="register-email" type="email" name="email" autoComplete="email" value={formData.email} onChange={handleChange} required />
          </div>
          <div className="form-group">
            <label htmlFor="register-password">Password</label>
            <input id="register-password" type="password" name="password" autoComplete="new-password" value={formData.password} onChange={handleChange} required />
          </div>
          <button type="submit" className="btn btn--primary">Create Account</button>
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign In</Link>
        </p>
      </div>
    </div>
  );
}
