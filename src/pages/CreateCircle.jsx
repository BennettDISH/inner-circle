import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

export default function CreateCircle() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.post('/api/circles', { name, description });
      navigate(`/circles/${data.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: '600px' }}>
      <h1 className="page-title">Create a New Circle</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
        A circle is a private space for you and your trusted friends or family to share resources.
      </p>

      <form onSubmit={handleSubmit} className="card">
        {error && <div className="alert alert--error">{error}</div>}
        
        <div className="form-group">
          <label>Circle Name</label>
          <input 
            value={name} 
            onChange={e => setName(e.target.value)} 
            placeholder="e.g. The Inner Circle, Smith Family, etc."
            required 
          />
        </div>

        <div className="form-group">
          <label>Description</label>
          <textarea 
            value={description} 
            onChange={e => setDescription(e.target.value)} 
            placeholder="What is this circle for? (Optional)"
          />
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" onClick={() => navigate('/')}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Creating...' : 'Create Circle'}
          </button>
        </div>
      </form>
    </div>
  );
}
