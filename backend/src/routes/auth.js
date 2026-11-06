import { Router } from 'express';
import { requireAuth, wrap } from '../middleware.js';
import { loginBody, registerBody } from '../validation.js';

export function authRoutes({ auth }) {
  const r = Router();

  r.post('/register', wrap(async (req, res) => {
    const user = await auth.register(registerBody.parse(req.body));
    res.status(201).location('/api/users/' + user.id + '/orders').json(user);
  }));

  r.post('/login', wrap(async (req, res) => {
    const result = await auth.login(loginBody.parse(req.body), { ip: req.ip, userAgent: req.get('user-agent') });
    res.json(result);
  }));

  // Revokes the calling session; the token stops working immediately.
  r.post('/logout', requireAuth(auth), wrap(async (req, res) => {
    await auth.logout(req.sessionId);
    res.status(204).end();
  }));

  return r;
}
