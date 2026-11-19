import { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { PenLine } from 'lucide-react';
import { AuthContext } from '../context/AuthContext';
import DotGrid from '../components/reactbits/DotGrid';
import SplitText from '../components/reactbits/SplitText';
import StarBorder from '../components/reactbits/StarBorder';
import './Auth.css';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, loginAsGuest } = useContext(AuthContext);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';

    try {
      const res = await fetch(`http://localhost:5000${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (res.ok) {
        if (isLogin) {
          login(data.token, data.username);
          navigate('/'); // Go to lobby after login
        } else {
          setNotice('Account created. Log in to continue.');
          setPassword('');
          setIsLogin(true);
        }
      } else {
        setError(data.message || data.error || 'Something went wrong.');
      }
    } catch (err) {
      console.error(err);
      setError('Network error. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  const continueAsGuest = async () => {
    setError('');
    try { await loginAsGuest(); navigate('/'); }
    catch { setError('Could not start a guest session.'); }
  };

  const switchMode = () => {
    setIsLogin((v) => !v);
    setError('');
    setNotice('');
  };

  return (
    <div className="auth">
      <div className="auth__bg" aria-hidden="true">
        <DotGrid
          baseColor="#222632"
          activeColor="#9bd3a5"
          dotSize={4}
          gap={22}
          proximity={130}
          shockRadius={280}
          glow={0.45}
          fade={0.55}
        />
      </div>

      <main className="auth__card">
        <div className="auth__brand">
          <span className="auth__logo"><PenLine size={18} /></span>
          <span>NetWrite</span>
        </div>

        <SplitText
          tag="h1"
          text={isLogin ? 'Welcome back' : 'Create your account'}
          className="auth__title"
          effect="rise"
          splitType="chars"
          delay={25}
          duration={0.9}
          trigger="load"
          textAlign="left"
        />
        <p className="auth__sub">
          {isLogin ? 'Log in to pick up where you left off.' : 'Sign up to keep every board you create.'}
        </p>

        <form onSubmit={handleSubmit} className="auth__form">
          <label className="auth__label">
            Username
            <input
              className="field"
              type="text"
              autoComplete="username"
              placeholder="your-name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label className="auth__label">
            Password
            <input
              className="field"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && <p className="auth__msg auth__msg--error" role="alert">{error}</p>}
          {notice && <p className="auth__msg auth__msg--ok" role="status">{notice}</p>}

          <StarBorder
            type="submit"
            className="auth__submit"
            color="#9bd3a5"
            trailColor="#9bd3a5"
            radius={12}
            duration={4.5}
            glow={0.55}
            hover="brighten"
            disabled={busy}
          >
            {busy ? 'Please wait…' : isLogin ? 'Log in' : 'Create account'}
          </StarBorder>
        </form>

        <div className="auth__or"><span>or</span></div>

        <button type="button" className="ghost-btn auth__guest" onClick={continueAsGuest}>
          Continue as guest
        </button>

        <button type="button" className="auth__switch" onClick={switchMode}>
          {isLogin ? "Don't have an account? Register" : 'Already have an account? Log in'}
        </button>
      </main>
    </div>
  );
}
