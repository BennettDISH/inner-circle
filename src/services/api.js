const apiFetch = async (url, options = {}) => {
  const token = localStorage.getItem('token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...options.headers,
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'An unknown error occurred' }));
    throw new Error(error.error || `HTTP error! status: ${res.status}`);
  }
  return res.json();
};

export const api = {
  get: (url) => apiFetch(url),
  post: (url, body) => apiFetch(url, { method: 'POST', body: JSON.stringify(body) }),
  put: (url, body) => apiFetch(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (url) => apiFetch(url, { method: 'DELETE' }),
};
