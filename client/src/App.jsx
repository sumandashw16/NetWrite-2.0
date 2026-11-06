import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Board from './pages/Board';
import Auth from './pages/Auth';
import ProtectedRoute from './components/auth/ProtectedRoute';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<Auth />} />
        
        {/* Protected Routes */}
        <Route 
          path="/" 
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/board/:roomId" 
          element={
            <ProtectedRoute>
              <Board />
            </ProtectedRoute>
          } 
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;