import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Signed out: sign in, then back to the page asked for. `admin` pages show a plain 403 to
// anyone signed in who is not the site admin; the server checks again on every /api/admin call.
export default function ProtectedRoute({ children, admin = false }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div>Loading...</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (admin && !user.is_admin) {
    return (
      <div className="page">
        <h1 className="page-title">403</h1>
        <p>This page is for the site admin.</p>
      </div>
    );
  }

  return children;
}
