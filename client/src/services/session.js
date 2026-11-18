export const API_URL = 'http://localhost:5000';

export function getSession() {
  const g = sessionStorage.getItem('guestToken');
  if (g) return { token: g, username: sessionStorage.getItem('guestName'), isGuest: true };
  const token = localStorage.getItem('token');
  const username = localStorage.getItem('username');
  return token && username ? { token, username, isGuest: false } : null;
}

export function saveSession({ token, username, isGuest }) {
  if (isGuest) {
    sessionStorage.setItem('guestToken', token);
    sessionStorage.setItem('guestName', username);
  } else {
    sessionStorage.removeItem('guestToken');
    sessionStorage.removeItem('guestName');
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
  }
}

export function clearSession() {
  if (getSession()?.isGuest) {
    sessionStorage.removeItem('guestToken');
    sessionStorage.removeItem('guestName');
  } else {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
  }
}