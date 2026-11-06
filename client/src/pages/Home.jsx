import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';

export default function Home() {
  const navigate = useNavigate();
  const [joinId, setJoinId] = useState('');

  const createNewBoard = () => {
    const newRoomId = uuidv4();
    navigate(`/board/${newRoomId}`);
  };

  const joinBoard = (e) => {
    e.preventDefault();
    if (joinId.trim()) {
      navigate(`/board/${joinId.trim()}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '20vh', fontFamily: 'sans-serif' }}>
      <h1>NetWrite Collaborative Whiteboard</h1>
      
      <button 
        onClick={createNewBoard}
        style={{ padding: '10px 20px', fontSize: '16px', cursor: 'pointer', marginBottom: '30px' }}
      >
        Create New Board
      </button>

      <form onSubmit={joinBoard} style={{ display: 'flex', gap: '10px' }}>
        <input 
          type="text" 
          placeholder="Paste Room ID here..." 
          value={joinId}
          onChange={(e) => setJoinId(e.target.value)}
          style={{ padding: '10px', fontSize: '16px', width: '250px' }}
        />
        <button type="submit" style={{ padding: '10px 20px', fontSize: '16px', cursor: 'pointer' }}>
          Join Board
        </button>
      </form>
    </div>
  );
}