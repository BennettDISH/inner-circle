import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import ListingPhotos from '../components/ListingPhotos';

export default function MyListings() {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/listings/mine')
      .then(data => setListings(data.listings || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const toggleActive = (id, currentActive) => {
    api.put(`/api/listings/${id}`, { active: !currentActive })
      .then(res => {
        // merged: the update's answer has neither the circle's name nor the photos
        setListings(listings.map(l => l.id === id ? { ...l, ...res.listing } : l));
      })
      .catch(err => alert(err.message));
  };

  const deleteListing = (id) => {
    if (!confirm('Are you sure you want to delete this listing?')) return;
    api.delete(`/api/listings/${id}`)
      .then(() => {
        setListings(listings.filter(l => l.id !== id));
      })
      .catch(err => alert(err.message));
  };

  if (loading) return <div className="loading">Loading your listings...</div>;

  return (
    <div className="page">
      <h1 className="page-title">My Listings</h1>
      
      {error && <div className="alert alert--error" role="alert">{error}</div>}

      {listings.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__text">You haven't posted any listings yet.</p>
        </div>
      ) : (
        <div className="card-grid">
          {listings.map(listing => (
            <div key={listing.id} className={`card ${!listing.active ? 'card--inactive' : ''}`} style={{ opacity: listing.active ? 1 : 0.6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <span className={`badge badge--${listing.kind}`}>{listing.kind.toUpperCase()}</span>
                  {listing.category && <span className="badge badge--count">{listing.category}</span>}
                </div>
                <span className="byline">in {listing.circle_name}</span>
              </div>
              <h3 className="card__title" style={{ marginTop: '0.5rem' }}>{listing.title}</h3>
              <p className="card__subtitle">{listing.description}</p>
              <ListingPhotos
                listing={listing}
                editable
                onChange={photos => setListings(listings.map(l => l.id === listing.id ? { ...l, photos } : l))}
              />
              {listing.availability && (
                <p className="card__subtitle" style={{ marginTop: '0.5rem' }}>
                  <strong>Availability:</strong> {listing.availability}
                </p>
              )}
              {listing.tags && listing.tags.length > 0 && (
                <div className="card__meta">
                  {listing.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}
                </div>
              )}
              
              <div className="card__meta" style={{ justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button 
                  className="btn btn--secondary btn--small"
                  onClick={() => toggleActive(listing.id, listing.active)}
                >
                  {listing.active ? 'Deactivate' : 'Reactivate'}
                </button>
                <button 
                  className="btn btn--danger btn--small"
                  onClick={() => deleteListing(listing.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
