import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { shrinkImage } from '../lib/shrinkImage';
import { MAX_PHOTOS } from '../components/ListingPhotos';

export default function CreateListing() {
  const { id: circleId } = useParams();
  const navigate = useNavigate();
  const { photosEnabled } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Photos picked before posting: shrunk Blobs with a preview, uploaded once the listing exists
  const [pending, setPending] = useState([]); // [{ blob, preview }]
  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  useEffect(() => () => pendingNow.current.forEach(p => URL.revokeObjectURL(p.preview)), []);

  const unpick = (item) => {
    URL.revokeObjectURL(item.preview);
    setPending(prev => prev.filter(p => p !== item));
  };

  const pick = async (e) => {
    const files = [...(e.target.files || [])].slice(0, MAX_PHOTOS - pending.length);
    e.target.value = '';
    setError('');
    try {
      const shrunk = [];
      for (const file of files) {
        const blob = await shrinkImage(file);
        shrunk.push({ blob, preview: URL.createObjectURL(blob) });
      }
      setPending(prev => [...prev, ...shrunk].slice(0, MAX_PHOTOS));
    } catch (err) {
      setError(err.message);
    }
  };
  const [formData, setFormData] = useState({
    kind: 'have',
    category: 'item',
    title: '',
    description: '',
    availability: '',
    tags: '',
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { listing } = await api.post('/api/listings', {
        ...formData,
        tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
        circle_id: Number(circleId),
      });
      // The listing is posted; its photos go up one by one. One that fails does not undo it.
      const failures = [];
      if (photosEnabled) {
        for (const item of pending) {
          try {
            await api.upload(`/api/listings/${listing.id}/photos`, item.blob);
          } catch (err) {
            failures.push(err.message);
          }
        }
      }
      if (failures.length) {
        alert(`Your listing is posted, but ${failures.length} photo(s) did not upload (${failures[0]}). You can add them from My Listings.`);
      }
      navigate(`/circles/${circleId}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: '600px' }}>
      <h1 className="page-title">Post a Listing</h1>
      
      <form onSubmit={handleSubmit} className="card">
        {error && <div className="alert alert--error" role="alert">{error}</div>}

        <div className="form-group">
          <label htmlFor="listing-kind">I have / I need</label>
          <select
            id="listing-kind"
            value={formData.kind} 
            onChange={e => setFormData({ ...formData, kind: e.target.value })}
          >
            <option value="have">I have something to offer</option>
            <option value="need">I am looking for something</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="listing-category">Category</label>
          <select
            id="listing-category"
            value={formData.category} 
            onChange={e => setFormData({ ...formData, category: e.target.value })}
          >
            <option value="item">Item</option>
            <option value="skill">Skill / Service</option>
            <option value="time">Time / Help</option>
            <option value="space">Space</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="listing-title">Title</label>
          <input
            id="listing-title"
            maxLength={255}
            value={formData.title}
            onChange={e => setFormData({ ...formData, title: e.target.value })}
            placeholder="e.g. Extra garden tools, Help with moving, etc."
            required 
          />
        </div>

        <div className="form-group">
          <label htmlFor="listing-description">Description</label>
          <textarea
            id="listing-description"
            value={formData.description} 
            onChange={e => setFormData({ ...formData, description: e.target.value })}
            placeholder="Provide some details..."
          />
        </div>

        <div className="form-group">
          <label htmlFor="listing-availability">Availability / Terms</label>
          <input
            id="listing-availability"
            value={formData.availability} 
            onChange={e => setFormData({ ...formData, availability: e.target.value })}
            placeholder="e.g. Free, Trade for coffee, Available weekends"
          />
        </div>

        {photosEnabled && (
          <div className="form-group">
            <label htmlFor="listing-photos">Photos (up to {MAX_PHOTOS})</label>
            {pending.length > 0 && (
              <div className="photo-strip">
                {pending.map(item => (
                  <div key={item.preview} className="photo-strip__item">
                    <img src={item.preview} alt="" className="photo-strip__img" />
                    <button type="button" className="photo-strip__remove" onClick={() => unpick(item)} aria-label="Remove photo">✕</button>
                  </div>
                ))}
              </div>
            )}
            {pending.length < MAX_PHOTOS && (
              <input id="listing-photos" type="file" accept="image/*" multiple onChange={pick} />
            )}
          </div>
        )}

        <div className="form-group">
          <label htmlFor="listing-tags">Tags (comma-separated)</label>
          <input
            id="listing-tags"
            value={formData.tags}
            onChange={e => setFormData({ ...formData, tags: e.target.value })}
            placeholder="e.g. garden, tools, weekend"
          />
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" onClick={() => navigate(`/circles/${circleId}`)}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Posting...' : 'Post Listing'}
          </button>
        </div>
      </form>
    </div>
  );
}
