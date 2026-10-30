import React, { useState, useEffect } from 'react';
import { api } from '../services/api';

export default function RequestsInbox() {
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('incoming');

  useEffect(() => {
    Promise.all([
      api.get('/api/requests?direction=incoming'),
      api.get('/api/requests?direction=outgoing')
    ])
      .then(([incRes, outRes]) => {
        setIncoming(incRes.requests || []);
        setOutgoing(outRes.requests || []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleStatus = (id, status, list, setList) => {
    api.put(`/api/requests/${id}`, { status })
      .then(res => {
        setList(list.map(r => r.id === id ? { ...r, status: res.request.status } : r));
      })
      .catch(err => alert(err.message));
  };

  if (loading) return <div className="loading">Loading requests...</div>;

  const currentRequests = activeTab === 'incoming' ? incoming : outgoing;

  return (
    <div className="page">
      <h1 className="page-title">Requests</h1>

      <div className="tabs">
        <button className={activeTab === 'incoming' ? 'active' : ''} aria-pressed={activeTab === 'incoming'} onClick={() => setActiveTab('incoming')}>
          Incoming ({incoming.length})
        </button>
        <button className={activeTab === 'outgoing' ? 'active' : ''} aria-pressed={activeTab === 'outgoing'} onClick={() => setActiveTab('outgoing')}>
          Outgoing ({outgoing.length})
        </button>
      </div>

      {error && <div className="alert alert--error" role="alert">{error}</div>}

      {currentRequests.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__text">No {activeTab} requests found.</p>
        </div>
      ) : (
        <div className="card-grid">
          {currentRequests.map(req => (
            <div key={req.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span className={`badge badge--${req.listing_kind}`}>{req.listing_kind.toUpperCase()}</span>
                <span className={`badge badge--${req.status}`}>{req.status.toUpperCase()}</span>
              </div>
              <h3 className="card__title">{req.listing_title}</h3>
              <p className="card__subtitle" style={{ fontStyle: 'italic', marginBottom: '1rem' }}>
                "{req.message || 'No message provided'}"
              </p>
              {req.status === 'pending' && !req.owner_in_circle && (
                <p className="card__subtitle">
                  {activeTab === 'incoming'
                    ? 'You left this circle, but you can still answer.'
                    : `${req.to_username} left this circle, but can still answer.`}
                </p>
              )}

              <div className="card__meta" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '1rem' }}>
                <span className="byline">
                  {activeTab === 'incoming' ? `From: ${req.from_username}` : `To: ${req.to_username}`}
                </span>
              </div>

              {activeTab === 'incoming' && req.status === 'pending' && (
                <div className="card__meta" style={{ justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                  <button className="btn btn--danger btn--small" onClick={() => handleStatus(req.id, 'declined', incoming, setIncoming)}>Decline</button>
                  <button className="btn btn--primary btn--small" onClick={() => handleStatus(req.id, 'accepted', incoming, setIncoming)}>Accept</button>
                </div>
              )}
              {activeTab === 'outgoing' && (req.status === 'pending' || req.status === 'accepted') && (
                <div className="card__meta" style={{ justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                  <button className="btn btn--secondary btn--small" onClick={() => handleStatus(req.id, 'cancelled', outgoing, setOutgoing)}>Cancel request</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
