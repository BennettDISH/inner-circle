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
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/api/listings', { ...formData, circle_id: Number(circleId) });
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
          <label>I have / I need</label>
          <select 
            value={formData.kind} 
            onChange={e => setFormData({ ...formData, kind: e.target.value })}
          >
            <option value="have">I have something to offer</option>
            <option value="need">I am looking for something</option>
          </select>
        </div>

        <div className="form-group">
          <label>Category</label>
          <select 
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
          <label>Title</label>
          <input 
            value={formData.title} 
            onChange={e => setFormData({ ...formData, title: e.target.value })}
            placeholder="e.g. Extra garden tools, Help with moving, etc."
            required 
          />
        </div>

        <div className="form-group">
          <label>Description</label>
          <textarea 
            value={formData.description} 
            onChange={e => setFormData({ ...formData, description: e.target.value })}
            placeholder="Provide some details..."
          />
        </div>

        <div className="form-group">
          <label>Availability / Terms</label>
          <input 
            value={formData.availability} 
            onChange={e => setFormData({ ...formData, availability: e.target.value })}
            placeholder="e.g. Free, Trade for coffee, Available weekends"
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
