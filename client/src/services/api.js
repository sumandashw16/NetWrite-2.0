import { API_URL, getSession } from './session';

export function apiFetch(path, opts = {}) {
  const token = getSession()?.token;
  return fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...opts.headers,
    },
  });
}