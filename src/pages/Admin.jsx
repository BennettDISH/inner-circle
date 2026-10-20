import React, { useState, useEffect } from 'react';
import { api } from '../services/api';

// Site admin: look-only lists of every account, circle, membership, listing and request.
// The server checks ADMIN_CENTRAL_USER_IDS on every call; this page only reads.

const name = (first, last, username) => [first, last].filter(Boolean).join(' ') || username;
const date = (value) => (value ? new Date(value).toLocaleDateString() : '');

// A count that opens another tab filtered to this row.
function Drill({ count, onClick }) {
  if (!count) return <span className="admin-muted">0</span>;
  return <button type="button" className="admin-link" onClick={onClick}>{count}</button>;
}

const TABS = {
  users: {
    label: 'Users',
    search: 'Name, email or id',
    head: ['Name', 'Email', 'Id', 'Circles', 'Listings', 'Requests sent', 'Joined'],
    row: (u, open) => [
      <>{name(u.first_name, u.last_name, u.username)} <span className="admin-muted">@{u.username}</span></>,
      u.email || <span className="admin-muted">none</span>,
      u.central_user_id,
      <Drill count={u.circle_count} onClick={() => open('circles', { user_id: u.central_user_id }, `in circles with @${u.username}`)} />,
      <Drill count={u.listing_count} onClick={() => open('listings', { user_id: u.central_user_id }, `posted by @${u.username}`)} />,
      <Drill count={u.requests_sent} onClick={() => open('requests', { user_id: u.central_user_id }, `to or from @${u.username}`)} />,
      date(u.created_at),
    ],
  },
  circles: {
    label: 'Circles',
    search: 'Name, description or creator',
    head: ['Circle', 'Created by', 'Members', 'Listings', 'Created'],
    row: (c, open) => [
      <><strong>{c.name}</strong>{c.description && <div className="admin-muted">{c.description}</div>}</>,
      `@${c.created_by_username}`,
      <Drill count={c.member_count} onClick={() => open('members', { circle_id: c.id }, `in ${c.name}`)} />,
      <>
        <Drill count={c.listing_count} onClick={() => open('listings', { circle_id: c.id }, `in ${c.name}`)} />
        {c.listing_count > c.active_listing_count && <span className="admin-muted"> ({c.active_listing_count} active)</span>}
      </>,
      date(c.created_at),
    ],
  },
  members: {
    label: 'Members',
    search: 'Member or circle name',
    head: ['Member', 'Circle', 'Role', 'Joined'],
    row: (m) => [
      <>{name(m.first_name, m.last_name, m.username)} <span className="admin-muted">@{m.username}</span></>,
      m.circle_name,
      <span className={`badge badge--${m.role === 'admin' ? 'admin' : 'count'}`}>{m.role}</span>,
      date(m.joined_at),
    ],
  },
  listings: {
    label: 'Listings',
    search: 'Title, description, tag or poster',
    head: ['Listing', 'Circle', 'Posted by', 'Requests', 'Posted'],
    row: (l, open) => [
      <>
        <span className={`badge badge--${l.kind}`}>{l.kind.toUpperCase()}</span>{' '}
        <strong>{l.title}</strong>
        {!l.active && <span className="admin-muted"> (inactive)</span>}
        {l.description && <div className="admin-muted">{l.description}</div>}
        {l.availability && <div className="admin-muted">Availability: {l.availability}</div>}
        {l.tags?.length > 0 && <div className="card__meta">{l.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      </>,
      l.circle_name,
      `@${l.username}`,
      <Drill count={l.request_count} onClick={() => open('requests', { listing_id: l.id }, `on "${l.title}"`)} />,
      date(l.created_at),
    ],
  },
  requests: {
    label: 'Requests',
    search: 'Message, listing or person',
    head: ['Listing', 'From', 'To', 'Message', 'Status', 'Sent'],
    row: (r) => [
      <><strong>{r.listing_title}</strong><div className="admin-muted">{r.circle_name}</div></>,
      `@${r.from_username}`,
      `@${r.to_username}`,
      r.message || <span className="admin-muted">no message</span>,
      <span className={`badge badge--${r.status}`}>{r.status}</span>,
      date(r.created_at),
    ],
  },
};

export default function Admin() {
  const [tab, setTab] = useState('users');
  const [filter, setFilter] = useState(null); // { params, label } from a drill-in
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), ...(search && { q: search }), ...filter?.params });
    let live = true;
    setError(null);
    api.get(`/api/admin/${tab}?${params}`)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, [tab, filter, search, page]);

  const show = (next, params = null, label = '') => {
    setTab(next);
    setFilter(params && { params, label });
    setQ('');
    setSearch('');
    setPage(1);
    setData(null);
  };

  const view = TABS[tab];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="page page--wide">
      <div className="page-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Site admin</h1>
        <span className="admin-muted">Look only: nothing here changes anything.</span>
      </div>

      <div className="tabs">
        {Object.entries(TABS).map(([key, t]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => show(key)}>{t.label}</button>
        ))}
      </div>

      <form className="admin-toolbar" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setPage(1); }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={view.search}
          aria-label={`Search ${view.label.toLowerCase()}`}
        />
        <button type="submit" className="btn btn--secondary btn--small">Search</button>
        {filter && (
          <span className="tag admin-filter">
            {view.label} {filter.label}
            <button type="button" onClick={() => show(tab)} aria-label="Clear filter">×</button>
          </span>
        )}
      </form>

      {error && <div className="alert alert--error">{error}</div>}

      {!data ? (
        !error && <div className="loading">Loading...</div>
      ) : data.items.length === 0 ? (
        <div className="empty-state"><p className="empty-state__text">Nothing found.</p></div>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr>{view.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id ?? item.central_user_id}>
                  {view.row(item, show).map((cell, i) => <td key={i}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div className="pager">
          <button className="btn btn--secondary btn--small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="admin-muted">Page {data.page} of {pages} · {data.total} total</span>
          <button className="btn btn--secondary btn--small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
