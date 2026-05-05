import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

export default function CircleView() {
  const { id } = useParams();
  const { user } = useAuth();
  const [circle, setCircle] = useState(null);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('all');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      api.get(`/api/circles/${id}`),
      api.get(`/api/listings?circle_id=${id}`)
    ])
      .then(([circleRes, listingsRes]) => {
        setCircle(circleRes.circle);
        setListings(listingsRes.listings || []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="loading">Loading circle...</div>;
  if (error) return <div className="page"><div className="alert alert--error">{error}</div></div>;

  const filteredListings = activeTab === 'all' 
    ? listings 
    : listings.filter(l => l.kind === activeTab);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{circle.name}</h1>
          <p className="byline">{circle.description}</p>
        </div>
        <div className="page-header__actions" style={{ display: 'flex', gap: '1rem' }}>
          <div className="join-code" title="Click to copy" onClick={() => {
            navigator.clipboard.writeText(circle.join_code);
            alert('Join code copied!');
          }}>
            {circle.join_code}
          </div>
          <button className="btn btn--primary" onClick={() => navigate(`/circles/${id}/listings/new`)}>
            Post Something
          </button>
        </div>
      </div>

      <div className="tabs">
        <button className={activeTab === 'all' ? 'active' : ''} onClick={() => setActiveTab('all')}>All</button>
        <button className={activeTab === 'have' ? 'active' : ''} onClick={() => setActiveTab('have')}>Offers</button>
        <button className={activeTab === 'need' ? 'active' : ''} onClick={() => setActiveTab('need')}>Needs</button>
      </div>

      {filteredListings.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__text">No listings found in this category.</p>
        </div>
      ) : (
        <div className="card-grid">
          {filteredListings.map(listing => (
            <div key={listing.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span className={`badge badge--${listing.kind}`}>
                  {listing.kind === 'have' ? 'OFFER' : 'NEED'}
                </span>
                <span className="byline">by {listing.username}</span>
              </div>
              <h3 className="card__title" style={{ marginTop: '0.5rem' }}>{listing.title}</h3>
              <p className="card__subtitle" style={{ marginBottom: '1rem' }}>{listing.description}</p>
              
              {listing.central_user_id !== user.central_user_id ? (
                <button 
                  className="btn btn--secondary btn--small btn--full"
                  onClick={() => {
                    const message = prompt('Send a message with your request:');
                    if (message !== null) {
                      api.post('/api/requests', { listing_id: listing.id, message })
                        .then(() => alert('Request sent!'))
                        .catch(err => alert(err.message));
                    }
                  }}
                >
                  Request
                </button>
              ) : (
                <span className="badge badge--count">Your Listing</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
