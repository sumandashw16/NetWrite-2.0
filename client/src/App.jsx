import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Board from './pages/Board';
import Auth from './pages/Auth'; // New import

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/" element={<Home />} />
        <Route path="/board/:roomId" element={<Board />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;