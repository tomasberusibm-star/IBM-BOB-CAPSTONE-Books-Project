-- =============================================================================
-- IBM BOB CAPSTONE Books Project - PostgreSQL schema (PostgreSQL 14+)
--
-- Apply with:
--   psql -v ON_ERROR_STOP=1 -d <database> -f db/schema.sql
--
-- Design notes
--   * Single-currency store (orders/payments carry a currency code for future use).
--   * Money is numeric(12,2); never float. Prices are snapshotted into order_items.
--   * Password hashes are produced by the application (argon2id / bcrypt); the
--     database only enforces that a hash, not a plaintext value, is stored.
--   * Card data: only brand + last4 + provider reference. Never store PAN/CVV.
--   * Gift points are an append-only ledger; a trigger maintains a cached
--     balance that can never go negative (row lock serialises concurrent redeems).
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive e-mail

-- -----------------------------------------------------------------------------
-- Enumerated types
-- -----------------------------------------------------------------------------
CREATE TYPE user_status    AS ENUM ('pending_verification', 'active', 'suspended', 'closed');
CREATE TYPE product_format AS ENUM ('hardcover', 'paperback', 'ebook', 'audiobook');
CREATE TYPE relation_type  AS ENUM ('similar', 'also_bought', 'series', 'accessory', 'other_format');
CREATE TYPE cart_status    AS ENUM ('active', 'converted', 'abandoned');
CREATE TYPE order_status   AS ENUM ('pending_payment', 'paid', 'processing', 'shipped',
                                    'delivered', 'cancelled', 'refunded');
CREATE TYPE payment_method AS ENUM ('card', 'paypal', 'bank_transfer');
CREATE TYPE payment_status AS ENUM ('pending', 'authorized', 'captured', 'failed', 'refunded');
CREATE TYPE points_entry   AS ENUM ('earn', 'redeem', 'refund', 'adjust', 'expire');

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Business rule: 1 gift point = 0.01 currency units.
CREATE FUNCTION gift_points_value(p_points integer) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT round(p_points * 0.01, 2) $$;

-- Delivery date shown to customers. Single source of truth for the catalogue,
-- basket, checkout and order snapshots.
--   * stock not tracked (e-books, audiobooks) -> NULL (delivered instantly)
--   * in stock                                -> stored date if it is still today or
--                                                later, otherwise today + p_lead_days
--   * out of stock                            -> stored restock date if it is still
--                                                today or later, otherwise NULL (unknown)
CREATE FUNCTION effective_delivery_date(p_stock integer, p_stored date, p_lead_days integer)
RETURNS date
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN p_stock IS NULL THEN NULL
        WHEN p_stock > 0 THEN
            CASE WHEN p_stored >= CURRENT_DATE THEN p_stored ELSE CURRENT_DATE + p_lead_days END
        ELSE
            CASE WHEN p_stored >= CURRENT_DATE THEN p_stored END
    END
$$;

-- =============================================================================
-- 1. USERS & AUTHENTICATION
-- =============================================================================
CREATE TABLE users (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,  -- safe to expose in URLs/APIs
    email             citext      NOT NULL UNIQUE,
    first_name        text        NOT NULL,
    last_name         text        NOT NULL,
    phone             text,
    status            user_status NOT NULL DEFAULT 'pending_verification',
    email_verified_at timestamptz,
    last_login_at     timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz,                                            -- soft delete
    CONSTRAINT users_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Credentials live in their own table so they are easy to lock down with GRANTs
-- and never leak through SELECT * on users.
CREATE TABLE user_credentials (
    user_id            bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    password_hash      text        NOT NULL,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    failed_login_count smallint    NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- reject anything that is not an argon2 / bcrypt encoded hash
    CONSTRAINT user_credentials_hash_format
        CHECK (password_hash ~ '^\$(argon2(id|i|d)|2[aby])\$')
);

-- One row per login state ("logged in on device X"). Only a hash of the opaque
-- session/refresh token is stored.
CREATE TABLE user_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),  -- SHA-256
    ip_address   inet,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    CONSTRAINT user_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_expires_idx     ON user_sessions (expires_at);

-- Audit trail for brute-force detection / alerting. Prune per retention policy.
CREATE TABLE login_attempts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint REFERENCES users (id) ON DELETE SET NULL,
    email        citext      NOT NULL,
    succeeded    boolean     NOT NULL,
    ip_address   inet,
    attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email, attempted_at DESC);
CREATE INDEX login_attempts_ip_idx    ON login_attempts (ip_address, attempted_at DESC);

CREATE TABLE addresses (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    label               text,
    recipient_name      text        NOT NULL,
    line1               text        NOT NULL,
    line2               text,
    city                text        NOT NULL,
    region              text,
    postal_code         text        NOT NULL,
    country_code        char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    phone               text,
    is_default_shipping boolean     NOT NULL DEFAULT false,
    -- false = one-off checkout address that is not shown in the user's address book
    is_saved            boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);
-- at most one default shipping address per user
CREATE UNIQUE INDEX addresses_one_default_idx ON addresses (user_id) WHERE is_default_shipping;

-- Immutable JSON copy of an address, stored on orders so history survives edits.
CREATE FUNCTION address_snapshot(a addresses) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT jsonb_build_object(
        'recipient_name', a.recipient_name, 'line1', a.line1, 'line2', a.line2,
        'city', a.city, 'region', a.region, 'postal_code', a.postal_code,
        'country_code', a.country_code, 'phone', a.phone)
$$;

-- =============================================================================
-- 2. PRODUCT CATALOGUE
-- =============================================================================
CREATE TABLE categories (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id  integer REFERENCES categories (id) ON DELETE RESTRICT,   -- adjacency list tree
    slug       text    NOT NULL UNIQUE,
    name       text    NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    CONSTRAINT categories_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX categories_parent_idx ON categories (parent_id);

CREATE TABLE brands (            -- publishers / imprints
    id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    name text NOT NULL
);

CREATE TABLE products (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku                     text           NOT NULL UNIQUE,
    slug                    text           NOT NULL UNIQUE,
    isbn13                  char(13)       UNIQUE CHECK (isbn13 ~ '^[0-9]{13}$'),
    brand_id                integer        NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
    title                   text           NOT NULL,
    authors                 text[]         NOT NULL DEFAULT '{}',
    description             text,
    format                  product_format NOT NULL,
    price                   numeric(12,2)  NOT NULL CHECK (price >= 0),
    -- NULL = stock not tracked (e.g. e-books); 0 = out of stock
    stock_quantity          integer        CHECK (stock_quantity >= 0),
    -- Estimated delivery / restock date shown to customers. NULL = instant or unknown.
    tentative_delivery_date date,
    published_on            date,
    is_active               boolean        NOT NULL DEFAULT true,
    created_at              timestamptz    NOT NULL DEFAULT now(),
    updated_at              timestamptz    NOT NULL DEFAULT now(),
    search                  tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED
);
CREATE INDEX products_brand_idx     ON products (brand_id);
CREATE INDEX products_search_idx    ON products USING gin (search);
CREATE INDEX products_delivery_idx  ON products (tentative_delivery_date) WHERE is_active;

-- Many-to-many product <-> category
CREATE TABLE product_categories (
    product_id  bigint  NOT NULL REFERENCES products (id)   ON DELETE CASCADE,
    category_id integer NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    is_primary  boolean NOT NULL DEFAULT false,
    PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_category_idx ON product_categories (category_id);
CREATE UNIQUE INDEX product_categories_one_primary_idx ON product_categories (product_id) WHERE is_primary;

-- Related product mappings ("customers also bought", other formats, series ...)
CREATE TABLE related_products (
    product_id         bigint        NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    related_product_id bigint        NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    relation           relation_type NOT NULL,
    sort_order         integer       NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, related_product_id, relation),
    CONSTRAINT related_products_not_self CHECK (product_id <> related_product_id)
);
CREATE INDEX related_products_reverse_idx ON related_products (related_product_id);

-- =============================================================================
-- 3. BASKET
-- =============================================================================
CREATE TABLE carts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status     cart_status NOT NULL DEFAULT 'active',
    -- chosen in checkout step 1 (POST /api/checkout/address)
    shipping_address_id bigint REFERENCES addresses (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- exactly one active basket per user
CREATE UNIQUE INDEX carts_one_active_idx ON carts (user_id) WHERE status = 'active';

CREATE TABLE cart_items (
    cart_id    bigint      NOT NULL REFERENCES carts (id)    ON DELETE CASCADE,
    product_id bigint      NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    quantity   integer     NOT NULL CHECK (quantity BETWEEN 1 AND 999),
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cart_id, product_id)
);
CREATE INDEX cart_items_product_idx ON cart_items (product_id);

-- =============================================================================
-- 4. GIFT POINTS (ledger + cached balance)
-- =============================================================================
CREATE TABLE gift_point_accounts (
    user_id    bigint      PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
    balance    integer     NOT NULL CHECK (balance >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- orders is created below; the ledger's order_id FK is added after it.
CREATE TABLE gift_points_ledger (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       bigint       NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    order_id      bigint,
    entry_type    points_entry NOT NULL,
    points        integer      NOT NULL CHECK (points <> 0),   -- signed
    balance_after integer      NOT NULL,                        -- set by trigger
    note          text,
    expires_at    timestamptz,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT gift_points_sign CHECK (
        (entry_type IN ('earn', 'refund') AND points > 0) OR
        (entry_type IN ('redeem', 'expire') AND points < 0) OR
        entry_type = 'adjust')
);
CREATE INDEX gift_points_ledger_user_idx  ON gift_points_ledger (user_id, created_at DESC);
CREATE INDEX gift_points_ledger_order_idx ON gift_points_ledger (order_id) WHERE order_id IS NOT NULL;

-- Keeps gift_point_accounts in step with the ledger. The UPDATE takes a row lock,
-- so concurrent redemptions are serialised and the CHECK (balance >= 0) rejects overdraw.
-- UPDATE-first (not INSERT ... ON CONFLICT): the proposed INSERT row is CHECKed
-- before conflict resolution, so it would fail even when the account already exists.
CREATE FUNCTION apply_gift_points_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE gift_point_accounts
    SET balance = balance + NEW.points, updated_at = now()
    WHERE user_id = NEW.user_id
    RETURNING balance INTO NEW.balance_after;

    IF NOT FOUND THEN
        -- first ledger entry for this user; a negative amount violates CHECK (balance >= 0)
        INSERT INTO gift_point_accounts (user_id, balance)
        VALUES (NEW.user_id, NEW.points)
        RETURNING balance INTO NEW.balance_after;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER gift_points_ledger_apply
    BEFORE INSERT ON gift_points_ledger
    FOR EACH ROW EXECUTE FUNCTION apply_gift_points_entry();

CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'gift_points_ledger is append-only; insert a compensating entry instead';
END $$;

CREATE TRIGGER gift_points_ledger_append_only
    BEFORE UPDATE OR DELETE ON gift_points_ledger
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- =============================================================================
-- 5. ORDER HISTORY, ORDER ITEMS, PAYMENTS
-- =============================================================================
CREATE SEQUENCE order_number_seq;

CREATE TABLE orders (
    id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_number              text         NOT NULL UNIQUE
                              DEFAULT 'BK-' || lpad(nextval('order_number_seq')::text, 10, '0'),
    user_id                   bigint       NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    shipping_address_id       bigint       REFERENCES addresses (id) ON DELETE SET NULL,
    shipping_address_snapshot jsonb        NOT NULL,
    status                    order_status NOT NULL DEFAULT 'pending_payment',
    currency                  char(3)      NOT NULL DEFAULT 'USD',
    subtotal_amount           numeric(12,2) NOT NULL CHECK (subtotal_amount >= 0),
    shipping_amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
    tax_amount                numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    gift_points_redeemed      integer      NOT NULL DEFAULT 0 CHECK (gift_points_redeemed >= 0),
    discount_amount           numeric(12,2) NOT NULL DEFAULT 0,
    total_amount              numeric(12,2) NOT NULL CHECK (total_amount >= 0),  -- money still owed
    placed_at                 timestamptz  NOT NULL DEFAULT now(),
    shipped_at                timestamptz,
    delivered_at              timestamptz,
    cancelled_at              timestamptz,
    cancel_reason             text,
    updated_at                timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT orders_discount_matches_points
        CHECK (discount_amount = gift_points_value(gift_points_redeemed)),
    CONSTRAINT orders_discount_le_subtotal CHECK (discount_amount <= subtotal_amount),
    CONSTRAINT orders_total_consistent
        CHECK (total_amount = subtotal_amount + shipping_amount + tax_amount - discount_amount)
);
CREATE INDEX orders_user_placed_idx ON orders (user_id, placed_at DESC);   -- order history
CREATE INDEX orders_status_idx      ON orders (status) WHERE status IN ('pending_payment', 'processing', 'shipped');

ALTER TABLE gift_points_ledger
    ADD CONSTRAINT gift_points_ledger_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT;

CREATE TABLE order_items (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id                bigint        NOT NULL REFERENCES orders (id)   ON DELETE CASCADE,
    product_id              bigint        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    -- snapshots: history must not change when the catalogue does
    product_sku             text          NOT NULL,
    product_title           text          NOT NULL,
    unit_price              numeric(12,2) NOT NULL CHECK (unit_price >= 0),
    quantity                integer       NOT NULL CHECK (quantity > 0),
    line_total              numeric(12,2) GENERATED ALWAYS AS (unit_price * quantity) STORED,
    tentative_delivery_date date,
    UNIQUE (order_id, product_id)
);
CREATE INDEX order_items_product_idx ON order_items (product_id);

CREATE TABLE payments (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id           bigint         NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
    method             payment_method NOT NULL,
    status             payment_status NOT NULL DEFAULT 'pending',
    amount             numeric(12,2)  NOT NULL CHECK (amount > 0),
    currency           char(3)        NOT NULL DEFAULT 'USD',
    provider           text,                              -- e.g. PSP name
    provider_reference text,                              -- PSP transaction / intent id
    card_brand         text,
    card_last4         char(4) CHECK (card_last4 ~ '^[0-9]{4}$'),
    card_type          text    CHECK (card_type IN ('credit', 'debit')),
    created_at         timestamptz    NOT NULL DEFAULT now(),
    captured_at        timestamptz,
    updated_at         timestamptz    NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_reference)
);
CREATE INDEX payments_order_idx ON payments (order_id);

-- Replay protection for POST /api/checkout/payment. The row is inserted inside the
-- checkout transaction, so a concurrent request with the same key waits for the first
-- one to commit and then receives its stored response; a rolled-back attempt leaves
-- no row and can be retried. The stored response contains order data (PII): purge
-- rows older than 24 h with a scheduled job, e.g.
--   DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
CREATE TABLE idempotency_keys (
    user_id         bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key             text        NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,64}$'),
    request_hash    text        NOT NULL,                 -- SHA-256 of the canonical request body
    response_status smallint,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- -----------------------------------------------------------------------------
-- "Buy it again": what a user has bought before, most recent first, limited to
-- products that can still be bought.
-- -----------------------------------------------------------------------------
CREATE VIEW v_buy_it_again AS
SELECT o.user_id,
       p.id                                              AS product_id,
       p.sku,
       p.title,
       count(DISTINCT o.id)                              AS times_ordered,
       sum(oi.quantity)                                  AS total_quantity,
       max(o.placed_at)                                  AS last_ordered_at,
       (array_agg(oi.unit_price ORDER BY o.placed_at DESC))[1] AS last_unit_price,
       p.price                                           AS current_price,
       p.stock_quantity,
       p.tentative_delivery_date
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
  AND p.is_active
GROUP BY o.user_id, p.id;

-- Copy every still-active item of a past order into the user's active basket
-- (creating the basket if needed). Returns the number of products added.
CREATE FUNCTION reorder_to_cart(p_user_id bigint, p_order_id bigint) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    v_cart_id bigint;
    v_count   integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orders WHERE id = p_order_id AND user_id = p_user_id) THEN
        RAISE EXCEPTION 'Order % not found for user %', p_order_id, p_user_id;
    END IF;

    INSERT INTO carts (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) WHERE status = 'active'
        DO UPDATE SET updated_at = now()
    RETURNING id INTO v_cart_id;

    INSERT INTO cart_items (cart_id, product_id, quantity)
    SELECT v_cart_id, oi.product_id, oi.quantity
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id AND p.is_active
    WHERE oi.order_id = p_order_id
    ON CONFLICT (cart_id, product_id)
        DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, 999);

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END $$;

-- -----------------------------------------------------------------------------
-- Checkout: turns the user's active basket into an order in ONE transaction:
-- validates stock, snapshots prices/address, redeems gift points, decrements
-- stock and closes the basket. Returns the new order id. The payment row is
-- created by the application once the PSP responds.
-- -----------------------------------------------------------------------------
CREATE FUNCTION place_order(
    p_user_id          bigint,
    p_address_id       bigint,
    p_points_to_redeem integer       DEFAULT 0,
    p_shipping_amount  numeric(12,2) DEFAULT 0,
    p_tax_amount       numeric(12,2) DEFAULT 0
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_cart_id  bigint;
    v_address  addresses;
    v_subtotal numeric(12,2);
    v_discount numeric(12,2);
    v_total    numeric(12,2);
    v_order_id bigint;
BEGIN
    IF p_points_to_redeem < 0 OR p_shipping_amount < 0 OR p_tax_amount < 0 THEN
        RAISE EXCEPTION 'Points, shipping and tax must not be negative';
    END IF;

    SELECT id INTO v_cart_id FROM carts
    WHERE user_id = p_user_id AND status = 'active' FOR UPDATE;
    IF v_cart_id IS NULL THEN
        RAISE EXCEPTION 'User % has no active basket', p_user_id;
    END IF;

    SELECT * INTO v_address FROM addresses WHERE id = p_address_id AND user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Address % does not belong to user %', p_address_id, p_user_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM cart_items WHERE cart_id = v_cart_id) THEN
        RAISE EXCEPTION 'Basket is empty';
    END IF;

    -- lock products in a fixed order to avoid deadlocks between concurrent checkouts
    PERFORM 1 FROM products
    WHERE id IN (SELECT product_id FROM cart_items WHERE cart_id = v_cart_id)
    ORDER BY id FOR UPDATE;

    IF EXISTS (SELECT 1 FROM cart_items ci JOIN products p ON p.id = ci.product_id
               WHERE ci.cart_id = v_cart_id AND NOT p.is_active) THEN
        RAISE EXCEPTION 'Basket contains products that are no longer available';
    END IF;

    IF EXISTS (SELECT 1 FROM cart_items ci JOIN products p ON p.id = ci.product_id
               WHERE ci.cart_id = v_cart_id
                 AND p.stock_quantity IS NOT NULL AND p.stock_quantity < ci.quantity) THEN
        RAISE EXCEPTION 'Insufficient stock for one or more basket items';
    END IF;

    SELECT sum(p.price * ci.quantity) INTO v_subtotal
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.cart_id = v_cart_id;

    v_discount := gift_points_value(p_points_to_redeem);
    IF v_discount > v_subtotal THEN
        RAISE EXCEPTION 'Gift points value (%) exceeds the basket subtotal (%)', v_discount, v_subtotal;
    END IF;
    v_total := v_subtotal + p_shipping_amount + p_tax_amount - v_discount;

    INSERT INTO orders (user_id, shipping_address_id, shipping_address_snapshot, status,
                        subtotal_amount, shipping_amount, tax_amount,
                        gift_points_redeemed, discount_amount, total_amount)
    VALUES (p_user_id, p_address_id, address_snapshot(v_address),
            CASE WHEN v_total = 0 THEN 'paid'::order_status ELSE 'pending_payment'::order_status END,
            v_subtotal, p_shipping_amount, p_tax_amount,
            p_points_to_redeem, v_discount, v_total)
    RETURNING id INTO v_order_id;

    INSERT INTO order_items (order_id, product_id, product_sku, product_title,
                             unit_price, quantity, tentative_delivery_date)
    SELECT v_order_id, p.id, p.sku, p.title, p.price, ci.quantity, p.tentative_delivery_date
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.cart_id = v_cart_id;

    UPDATE products p SET stock_quantity = p.stock_quantity - ci.quantity
    FROM cart_items ci
    WHERE ci.cart_id = v_cart_id AND ci.product_id = p.id AND p.stock_quantity IS NOT NULL;

    IF p_points_to_redeem > 0 THEN
        -- trigger + CHECK (balance >= 0) abort the whole checkout on insufficient points
        INSERT INTO gift_points_ledger (user_id, order_id, entry_type, points, note)
        VALUES (p_user_id, v_order_id, 'redeem', -p_points_to_redeem, 'Redeemed at checkout');
    END IF;

    UPDATE carts SET status = 'converted' WHERE id = v_cart_id;

    RETURN v_order_id;
END $$;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at            BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_credentials_set_updated_at BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER addresses_set_updated_at        BEFORE UPDATE ON addresses        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_set_updated_at         BEFORE UPDATE ON products         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER carts_set_updated_at            BEFORE UPDATE ON carts            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_set_updated_at           BEFORE UPDATE ON orders           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_set_updated_at         BEFORE UPDATE ON payments         FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
