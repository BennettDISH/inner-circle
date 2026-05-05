import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import AuthCallback from './pages/AuthCallback';
import Dashboard from './pages/Dashboard';
import CreateCircle from './pages/CreateCircle';
import CircleView from './pages/CircleView';
import CreateListing from './pages/CreateListing';
import MyListings from './pages/MyListings';
import RequestsInbox from './pages/RequestsInbox';

function Nav() {
  const { user, logout } = useAuth();
  const location = useLocation();
  if (!user) return null;

  const isActive = (path) => location.pathname === path ? 'nav__link nav__link--active' : 'nav__link';

  return (
    <nav className="nav">
      <Link to="/" className="nav__logo">inner circle</Link>
      <div className="nav__links">
        <Link to="/" className={isActive('/')}>Circles</Link>
        <Link to="/my-listings" className={isActive('/my-listings')}>My Listings</Link>
        <Link to="/requests" className={isActive('/requests')}>Requests</Link>
        <button onClick={logout} className="btn btn--secondary" style={{ padding: '4px 12px', fontSize: '0.85rem' }}>
          Sign Out
        </button>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <div className="app">
      <Nav />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/circles/create" element={<ProtectedRoute><CreateCircle /></ProtectedRoute>} />
        <Route path="/circles/:id" element={<ProtectedRoute><CircleView /></ProtectedRoute>} />
        <Route path="/circles/:id/listings/new" element={<ProtectedRoute><CreateListing /></ProtectedRoute>} />
        <Route path="/my-listings" element={<ProtectedRoute><MyListings /></ProtectedRoute>} />
        <Route path="/requests" element={<ProtectedRoute><RequestsInbox /></ProtectedRoute>} />
      </Routes>
    </div>
  );
}
