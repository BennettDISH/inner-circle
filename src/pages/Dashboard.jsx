import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

export default function Dashboard() {
  const [circles, setCircles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/circles')
      .then(data => setCircles(data.circles || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading your circles...</div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Your Circles</h1>
        <Link to="/circles/create" className="btn btn--primary">Create New Circle</Link>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {circles.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__icon">⭕</div>
          <p className="empty-state__text">You haven't joined any circles yet.</p>
          <div className="card-grid" style={{ marginTop: '2rem' }}>
            <div className="card">
              <h3 className="card__title">Have a join code?</h3>
              <p className="card__subtitle">Enter a code from a friend to join their circle.</p>
              <form style={{ marginTop: '1rem' }} onSubmit={(e) => {
                e.preventDefault();
                const code = e.target.code.value;
                api.post('/api/circles/join', { code })
                  .then(() => window.location.reload())
                  .catch(err => alert(err.message));
              }}>
                <div className="form-group">
                  <input name="code" placeholder="ENTER-CODE" style={{ textAlign: 'center', letterSpacing: '2px' }} required />
                </div>
                <button type="submit" className="btn btn--secondary btn--full">Join Circle</button>
              </form>
            </div>
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {circles.map(circle => (
            <Link key={circle.id} to={`/circles/${circle.id}`} className="card">
              <h3 className="card__title">{circle.name}</h3>
              <p className="card__subtitle">{circle.description}</p>
              <div className="card__meta">
                <span className="badge badge--count">{circle.member_count} members</span>
                <span className="badge badge--count">{circle.listing_count} listings</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
