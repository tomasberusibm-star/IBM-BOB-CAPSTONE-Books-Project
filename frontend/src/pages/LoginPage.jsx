import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button, TextField } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

/** Only same-site paths are valid post-login destinations (prevents open redirects). */
export function safeRedirect(target, fallback = '/') {
  return typeof target === 'string' && /^\/(?![/\\])/.test(target) ? target : fallback;
}

export default function LoginPage() {
  const { login, register, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [fields, setFields] = useState({ email: '', password: '', first_name: '', last_name: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const from = safeRedirect(location.state?.from);
  if (isAuthenticated && !busy) return <Navigate to={from} replace />;

  const isRegister = mode === 'register';
  const set = (name) => (e) => setFields((f) => ({ ...f, [name]: e.target.value }));

  function validate() {
    const e = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email.trim())) e.email = 'Enter a valid e-mail address.';
    if (isRegister) {
      if (fields.password.length < 12) e.password = 'Use at least 12 characters.';
      if (!fields.first_name.trim()) e.first_name = 'Enter your first name.';
      if (!fields.last_name.trim()) e.last_name = 'Enter your last name.';
    } else if (!fields.password) {
      e.password = 'Enter your password.';
    }
    return e;
  }

  async function onSubmit(event) {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const email = fields.email.trim();
      if (isRegister) {
        const user = await register({ email, password: fields.password, first_name: fields.first_name.trim(), last_name: fields.last_name.trim() });
        if (user.status === 'active') {
          await login(email, fields.password);
          return navigate(from, { replace: true });
        }
        setNotice('Account created. Please verify your e-mail address, then sign in.');
        setMode('login');
        setFields((f) => ({ ...f, password: '' }));
      } else {
        await login(email, fields.password);
        navigate(from, { replace: true });
      }
    } catch (err) {
      const byField = {};
      for (const d of err.details ?? []) if (d.field && !byField[d.field]) byField[d.field] = d.issue;
      setErrors(byField);
      setFormError(err.status === 429 ? 'Too many attempts. Please wait a moment and try again.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="font-serif text-3xl font-bold">{isRegister ? 'Create your account' : 'Welcome back'}</h1>
        <p className="mt-1 text-stone-600">{isRegister ? 'Join to save a basket, earn gift points and re-order in a click.' : 'Sign in to see your basket, orders and recommendations.'}</p>

        {notice && (
          <p role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
            {notice}
          </p>
        )}
        {formError && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">
            {formError}
          </p>
        )}

        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          {isRegister && (
            <div className="grid grid-cols-2 gap-3">
              <TextField id="first_name" label="First name" autoComplete="given-name" value={fields.first_name} onChange={set('first_name')} error={errors.first_name} maxLength={100} />
              <TextField id="last_name" label="Last name" autoComplete="family-name" value={fields.last_name} onChange={set('last_name')} error={errors.last_name} maxLength={100} />
            </div>
          )}
          <TextField id="email" label="E-mail" type="email" autoComplete="email" inputMode="email" value={fields.email} onChange={set('email')} error={errors.email} maxLength={254} />
          <TextField
            id="password"
            label="Password"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={fields.password}
            onChange={set('password')}
            error={errors.password}
            hint={isRegister ? 'At least 12 characters. A passphrase works well.' : undefined}
            maxLength={128}
          />
          <Button type="submit" size="lg" busy={busy} className="w-full">
            {isRegister ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-stone-600">
          {isRegister ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="font-medium text-brand-700 underline underline-offset-2"
            onClick={() => {
              setMode(isRegister ? 'login' : 'register');
              setErrors({});
              setFormError(null);
            }}
          >
            {isRegister ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </div>
      <p className="mt-4 text-center text-sm text-stone-500">
        <Link to="/books" className="underline underline-offset-2">
          Continue browsing without signing in
        </Link>
      </p>
    </div>
  );
}
