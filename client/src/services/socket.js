import { io } from 'socket.io-client';
import { API_URL, getSession } from './session';

export const socket = io(API_URL, {
  autoConnect: false,   // AuthProvider connects once there is an identity
  auth: (cb) => cb({ token: getSession()?.token ?? '' }),
});

// Emit with an ack, waiting for the connection if needed
export function emitAck(event, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const send = () =>
      socket.timeout(timeout).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
    if (socket.connected) send();
    else {
      const t = setTimeout(() => { socket.off('connect', send); reject(new Error('not connected')); }, timeout);
      socket.once('connect', () => { clearTimeout(t); send(); });
    }
  });
}