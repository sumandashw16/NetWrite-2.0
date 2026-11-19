import { useState, useEffect } from 'react';
import { socket } from '../../services/socket';
import { colorFor } from './PeoplePanel';

export default function LiveCursors({ camera = { x: 0, y: 0, scale: 1 } }) {
  const [cursors, setCursors] = useState({});

  useEffect(() => {
    const onCursor = (data) => {
      setCursors((prev) => ({
        ...prev,
        [data.socketId]: { x: data.x, y: data.y, username: data.username }
      }));
    };
    const onGone = (socketId) => {
      setCursors((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    };

    socket.on('receive-cursor', onCursor);
    socket.on('user-disconnected', onGone);

    return () => {
      // remove only OUR handlers, not every listener on these events
      socket.off('receive-cursor', onCursor);
      socket.off('user-disconnected', onGone);
    };
  }, []);

  return (
    <>
      {Object.entries(cursors).map(([socketId, data]) => {
        const c = colorFor(data.username);   // same colour as that person's avatar
        return (
          <div
            key={socketId}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: `translate(${data.x * camera.scale + camera.x}px, ${data.y * camera.scale + camera.y}px)`,
              transition: 'transform 0.05s linear',
              pointerEvents: 'none',
              zIndex: 50,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 2
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill={c} xmlns="http://www.w3.org/2000/svg"
              style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.45))' }}>
              <path d="M4 2L20 12L11.5 13.5L8 22L4 2Z" stroke="white" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            <span
              style={{
                marginTop: 12,
                background: c,
                color: 'rgba(0,0,0,0.78)',
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 12,
                whiteSpace: 'nowrap',
                boxShadow: '0 2px 6px rgba(0,0,0,0.35)'
              }}
            >
              {data.username}
            </span>
          </div>
        );
      })}
    </>
  );
}
