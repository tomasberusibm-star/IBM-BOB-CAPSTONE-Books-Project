import { Router } from 'express';
import { requireAuth, requireSelf, wrap } from '../middleware.js';
import { cancelBody, orderParams, ordersQuery, userParams } from '../validation.js';

export function orderRoutes({ auth, orders }) {
  const r = Router();
  const authed = requireAuth(auth);

  r.get('/users/:id/orders', authed, (req, res, next) => {
    // Reject a malformed id before comparing it with the caller's id.
    const parsed = userParams.safeParse(req.params);
    if (!parsed.success) return next(parsed.error);
    next();
  }, requireSelf, wrap(async (req, res) => {
    const q = ordersQuery.parse(req.query);
    res.json(await orders.listForUser(req.user.id, { status: q.status, page: q.page, pageSize: q.page_size }));
  }));

  r.post('/orders/reorder/:orderId', authed, wrap(async (req, res) => {
    const { orderId } = orderParams.parse(req.params);
    res.json(await orders.reorder(req.user.id, orderId));
  }));

  r.post('/orders/cancel/:orderId', authed, wrap(async (req, res) => {
    const { orderId } = orderParams.parse(req.params);
    const body = cancelBody.parse(req.body);
    res.json(await orders.cancel(req.user.id, orderId, body.reason));
  }));

  return r;
}
