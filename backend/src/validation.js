import { z } from 'zod';

const id = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const id32 = z.coerce.number().int().min(1).max(2_147_483_647);
const trimmed = (max, min = 1) => z.string().trim().min(min).max(max);

const pagination = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const registerBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(12).max(128),
  first_name: trimmed(100),
  last_name: trimmed(100),
  phone: z.string().trim().max(32).regex(/^\+?[0-9 ()-]{6,32}$/).optional(),
});

export const loginBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(128),
});

export const categoryParams = z.object({ id: id32 });
export const productParams = z.object({ id });
export const orderParams = z.object({ orderId: id });
export const userParams = z.object({ id: z.uuid() });

const slug = z.string().regex(/^[a-z0-9-]{1,100}$/);

export const productListQuery = z.object({
  include_subcategories: bool.default(true),
  // GET /api/products only
  category_id: id32.optional(),
  // `brand` may repeat (?brand=ace&brand=pearson) or be comma separated
  brand: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : [v].flat().flatMap((s) => s.split(','))))
    .pipe(z.array(slug).max(20).optional()),
  q: z.string().trim().min(1).max(200).optional(),
  available_only: bool.default(false),
  deliver_by: z.iso.date().optional(),
  sort: z.enum(['title', 'price_asc', 'price_desc', 'newest', 'delivery']).default('title'),
  ...pagination,
});

export const relatedQuery = z.object({
  relation: z.enum(['similar', 'also_bought', 'series', 'accessory', 'other_format']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const recommendationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const ordersQuery = z.object({
  status: z.enum(['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']).optional(),
  ...pagination,
});

export const cancelBody = z.strictObject({ reason: z.string().trim().max(500).optional() }).default({});

export const addBasketItemBody = z.strictObject({
  product_id: id,
  quantity: z.number().int().min(1).max(999),
});

const addressInput = z.strictObject({
  label: trimmed(50).optional(),
  recipient_name: trimmed(150),
  line1: trimmed(200),
  line2: trimmed(200).optional(),
  city: trimmed(100),
  region: trimmed(100).optional(),
  postal_code: trimmed(20),
  country_code: z.string().regex(/^[A-Z]{2}$/),
  phone: trimmed(32).optional(),
  save_to_address_book: z.boolean().default(false),
});

export const checkoutAddressBody = z.union([
  z.strictObject({ address_id: id }),
  z.strictObject({ address: addressInput }),
]);

export const idempotencyKeyHeader = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const paymentBody = z
  .strictObject({
    gift_points_to_redeem: z.number().int().min(0).max(100_000_000).default(0),
    card: z
      .strictObject({
        payment_token: z.string().min(8).max(255).regex(/^[A-Za-z0-9_-]+$/),
        card_type: z.enum(['credit', 'debit']),
      })
      .optional(),
  })
  .refine((b) => b.card !== undefined || b.gift_points_to_redeem > 0, {
    message: 'Provide a card, gift points, or both',
    path: ['card'],
  });
