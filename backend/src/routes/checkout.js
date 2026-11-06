import { Router } from 'express';
import { AppError } from '../errors.js';
import { requireAuth, wrap } from '../middleware.js';
import {
  addBasketItemBody,
  basketItemParams,
  checkoutAddressBody,
  idempotencyKeyHeader,
  paymentBody,
  setQuantityBody,
} from '../validation.js';

export function checkoutRoutes({ auth, basket, checkout }) {
  const r = Router();
  const authed = requireAuth(auth);

  r.get('/basket', authed, wrap(async (req, res) => {
    res.json(await basket.get(req.user.id));
  }));

  r.patch('/basket/items/:productId', authed, wrap(async (req, res) => {
    const { productId } = basketItemParams.parse(req.params);
    res.json(await basket.setQuantity(req.user.id, productId, setQuantityBody.parse(req.body).quantity));
  }));

  r.delete('/basket/items/:productId', authed, wrap(async (req, res) => {
    const { productId } = basketItemParams.parse(req.params);
    res.json(await basket.removeItem(req.user.id, productId));
  }));

  r.get('/addresses', authed, wrap(async (req, res) => {
    res.json({ items: await checkout.listAddresses(req.user.id) });
  }));

  r.post('/basket/items', authed, wrap(async (req, res) => {
    res.json(await basket.addItem(req.user.id, addBasketItemBody.parse(req.body)));
  }));

  r.post('/checkout/address', authed, wrap(async (req, res) => {
    res.json(await checkout.setAddress(req.user.id, checkoutAddressBody.parse(req.body)));
  }));

  r.post('/checkout/payment', authed, wrap(async (req, res) => {
    const key = idempotencyKeyHeader.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw new AppError(400, 'VALIDATION_FAILED', 'The request is invalid.', [
        { field: 'Idempotency-Key', issue: 'is required: 16-64 characters from A-Z, a-z, 0-9, _ and -' },
      ]);
    }
    const result = await checkout.pay(req.user.id, key.data, paymentBody.parse(req.body));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).location('/api/users/' + req.user.publicId + '/orders').json(result.body);
  }));

  return r;
}
