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
import Admin from './pages/Admin';

function Nav() {
  const { user, logout, ssoLogin, ssoEnabled } = useAuth();
  const location = useLocation();
  if (!user) return null;

  // The current page's link is marked for screen readers as well as by colour.
  const navLink = (path, label) => {
    const here = location.pathname === path;
    return (
      <Link to={path} className={here ? 'nav__link nav__link--active' : 'nav__link'} aria-current={here ? 'page' : undefined}>
        {label}
      </Link>
    );
  };

  return (
    <nav className="nav">
      <Link to="/" className="nav__logo">inner circle</Link>
      <div className="nav__links">
        {navLink('/', 'Circles')}
        {navLink('/my-listings', 'My Listings')}
        {navLink('/requests', 'Requests')}
        {user.is_admin && navLink('/admin', 'Admin')}
        {ssoEnabled && (
          <button onClick={() => ssoLogin(location.pathname, { prompt: 'login' })} className="btn btn--secondary" style={{ padding: '4px 12px', fontSize: '0.85rem' }}>
            Switch Account
          </button>
        )}
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
      <main className="app__main">
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
          <Route path="/admin" element={<ProtectedRoute admin><Admin /></ProtectedRoute>} />
        </Routes>
      </main>
    </div>
  );
}
