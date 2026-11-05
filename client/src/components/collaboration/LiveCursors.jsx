import { useState, useEffect } from 'react';
import { socket } from '../../services/socket';

export default function LiveCursors() {
  const [cursors, setCursors] = useState({});

  useEffect(() => {
    socket.on('receive-cursor', (data) => {
      setCursors((prev) => ({
        ...prev,
        [data.socketId]: { x: data.x, y: data.y }
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
      {Object.entries(cursors).map(([socketId, pos]) => (
        <div
          key={socketId}
          className="absolute pointer-events-none z-50 flex items-center gap-1"
          style={{ 
            position: 'absolute',
            pointerEvents: 'none',
            zIndex: 50,
            left: 0, 
            top: 0, 
            transform: `translate(${pos.x}px, ${pos.y}px)`,
            transition: 'transform 0.05s linear' // Smooth out the movement
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#ef4444" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 2L20 12L11.5 13.5L8 22L4 2Z" stroke="white" strokeWidth="2" strokeLinejoin="round"/>
          </svg>
          <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full shadow-md">
            Guest
          </span>
        </div>
      ))}
    </>
  );
}