import { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';

export default function ProtectedRoute({ children }) {
  const { user } = useContext(AuthContext);
  
  // If there is no user token, kick them back to the auth page
  if (!user) {
    return <Navigate to="/auth" />;
  }
  
  return children;
}