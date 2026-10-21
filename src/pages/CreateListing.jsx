import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';

export default function CreateListing() {
  const { id: circleId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
      await api.post('/api/listings', {
        ...formData,
        tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
        circle_id: Number(circleId),
      });
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
        {error && <div className="alert alert--error">{error}</div>}

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
