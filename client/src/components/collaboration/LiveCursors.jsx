import { useState, useEffect } from 'react';
import { socket } from '../../services/socket';

export default function LiveCursors({ camera = { x: 0, y: 0, scale: 1 } }) {
  const [cursors, setCursors] = useState({});

  useEffect(() => {
    socket.on('receive-cursor', (data) => {
      setCursors((prev) => ({
        ...prev,
        [data.socketId]: { 
          x: data.x, 
          y: data.y, 
          username: data.username // Save the username
        }
      }));
    });

    socket.on('user-disconnected', (socketId) => {
      setCursors((prev) => {
        const newCursors = { ...prev };
        delete newCursors[socketId];
        return newCursors;
      });
    });

    return () => {
      socket.off('receive-cursor');
      socket.off('user-disconnected');
    };
  }, []);

  return (
    <>
      {Object.entries(cursors).map(([socketId, data]) => (
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
            alignItems: 'center',
            gap: '4px'
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#ef4444" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 2L20 12L11.5 13.5L8 22L4 2Z" stroke="white" strokeWidth="2" strokeLinejoin="round"/>
          </svg>
          {/* Display the actual username here */}
          <span style={{ background: '#ef4444', color: 'white', fontSize: '10px', padding: '2px 8px', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.2)' }}>
            {data.username}
          </span>
        </div>
      ))}
    </>
  );
}