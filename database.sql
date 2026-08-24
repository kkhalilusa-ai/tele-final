-- Telegram Store Bot - backward-compatible Supabase/PostgreSQL migration
-- Back up the database before applying this file in production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Historical table from the original project. Kept unchanged for old records.
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  username VARCHAR(255),
  email VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  payment_amount INTEGER NOT NULL DEFAULT 1,
  payment_currency VARCHAR(10) DEFAULT 'XTR',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE subscriptions ALTER COLUMN email DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_created_at ON subscriptions(created_at DESC);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  language VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar', 'hi')),
  wallet_balance NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(20,8) NOT NULL CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  delivery_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  amount NUMERIC(20,8) NOT NULL CHECK (amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded', 'cancelled')),
  delivery_data TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_code VARCHAR(32) NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_amount NUMERIC(20,8) NOT NULL CHECK (requested_amount > 0),
  expected_amount NUMERIC(20,8) NOT NULL CHECK (expected_amount > 0),
  received_amount NUMERIC(20,8),
  currency VARCHAR(10) NOT NULL DEFAULT 'USDT',
  network VARCHAR(20),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('binance', 'usdt_trc20')),
  payment_address TEXT,
  transaction_id TEXT,
  provider_order_id TEXT,
  provider_prepay_id TEXT,
  provider_transaction_id TEXT,
  checkout_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pending_review', 'approved', 'rejected', 'expired', 'cancelled')),
  reservation_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by BIGINT,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'purchase', 'refund', 'adjustment')),
  amount NUMERIC(20,8) NOT NULL CHECK (amount <> 0),
  balance_after NUMERIC(20,8) NOT NULL CHECK (balance_after >= 0),
  reference_type VARCHAR(20) NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reference_type, reference_id, type)
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_states (
  telegram_id BIGINT PRIMARY KEY,
  state TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS received_amount NUMERIC(20,8);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS crypto_amount NUMERIC(30,9);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS price_used NUMERIC(30,12);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS price_source TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS price_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_transaction_id
  ON deposits(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_provider_order_id
  ON deposits(provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_provider_prepay_id
  ON deposits(provider_prepay_id) WHERE provider_prepay_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_provider_transaction_id
  ON deposits(provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_usdt_expected_amount
  ON deposits(payment_method, expected_amount) WHERE reservation_active = TRUE AND payment_method = 'usdt_trc20';

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, active);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_user_created ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

INSERT INTO categories(name, sort_order) VALUES
  ('Adobe', 10), ('Canva', 20), ('CapCut', 30), ('ChatGPT', 40), ('Coursera', 50),
  ('Cursor', 60), ('Figma', 70), ('Gemini', 80), ('Grok', 90), ('Leonardo', 100),
  ('Lovable', 110), ('Mails', 120), ('Microsoft', 130), ('N8N', 140), ('Netflix', 150),
  ('Notion', 160), ('Trial Card', 170), ('YouTube', 180), ('VPN', 190), ('Replit', 200),
  ('GitHub', 210), ('ElevenLabs', 220)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 13) Grants for tables new admin/service-role code will read and write
-- ---------------------------------------------------------------------------

ALTER TABLE merchant_referral_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE required_channels ENABLE ROW LEVEL SECURITY;
GRANT ALL ON merchant_referral_links, referral_commissions, required_channels TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

DO $$
DECLARE v_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['merchant_referral_links','referral_commissions','required_channels']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END $$;

COMMIT;

-- v6.4 Referral Controls
-- Adds per-user referral activation/deletion controls and preserves history.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_users_referral_active
  ON users(referral_active) WHERE referral_code IS NOT NULL;

-- Rebuild referral attribution so disabled user referral codes cannot acquire
-- new referred users. Merchant links continue to use their existing active flag.
CREATE OR REPLACE FUNCTION ensure_bot_user(
  p_telegram_id BIGINT,
  p_username TEXT,
  p_first_name TEXT,
  p_default_language TEXT DEFAULT 'en'
) RETURNS SETOF users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_default_language NOT IN ('en', 'ar', 'hi') THEN p_default_language := 'en'; END IF;
  RETURN QUERY
  INSERT INTO users(telegram_id, username, first_name, language)
  VALUES (p_telegram_id, p_username, p_first_name, p_default_language)
  ON CONFLICT (telegram_id) DO UPDATE SET
    username = EXCLUDED.username,
    first_name = EXCLUDED.first_name,
    updated_at = NOW()
  RETURNING users.*;
END;
$$;

CREATE OR REPLACE FUNCTION purchase_product(
  p_telegram_id BIGINT,
  p_product_id BIGINT,
  p_idempotency_key TEXT
) RETURNS TABLE(order_id BIGINT, product_name TEXT, amount NUMERIC, delivery TEXT, already_processed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_product products%ROWTYPE;
  v_order orders%ROWTYPE;
  v_balance NUMERIC(20,8);
BEGIN
  SELECT * INTO v_order FROM orders WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.amount, v_order.delivery_data, TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_user FROM users WHERE telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND OR NOT v_product.active THEN RAISE EXCEPTION 'PRODUCT_UNAVAILABLE'; END IF;
  IF v_product.stock <= 0 THEN RAISE EXCEPTION 'OUT_OF_STOCK'; END IF;
  IF v_user.wallet_balance < v_product.price THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;

  UPDATE products SET stock = stock - 1, updated_at = NOW()
    WHERE id = v_product.id AND stock > 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUT_OF_STOCK'; END IF;

  UPDATE users SET wallet_balance = wallet_balance - v_product.price, updated_at = NOW()
    WHERE id = v_user.id AND wallet_balance >= v_product.price
    RETURNING wallet_balance INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;

  INSERT INTO orders(user_id, product_id, product_name, amount, delivery_data, idempotency_key)
  VALUES (v_user.id, v_product.id, v_product.name, v_product.price, v_product.delivery_text, p_idempotency_key)
  RETURNING * INTO v_order;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'purchase', -v_product.price, v_balance, 'order', v_order.id::TEXT, v_product.name);

  RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.amount, v_order.delivery_data, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION create_deposit(
  p_telegram_id BIGINT,
  p_method TEXT,
  p_requested_amount NUMERIC,
  p_expiry_minutes INTEGER,
  p_payment_address TEXT DEFAULT NULL
) RETURNS TABLE(
  id UUID, deposit_code TEXT, requested_amount NUMERIC, expected_amount NUMERIC,
  currency TEXT, payment_method TEXT, payment_address TEXT, status TEXT, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_id UUID;
  v_code TEXT;
  v_expected NUMERIC(20,8);
  v_expires TIMESTAMPTZ;
  v_attempt INTEGER;
BEGIN
  IF p_method NOT IN ('binance', 'usdt_trc20') THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
  IF p_requested_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_expiry_minutes < 1 OR p_expiry_minutes > 1440 THEN RAISE EXCEPTION 'INVALID_EXPIRY'; END IF;

  SELECT * INTO v_user FROM users WHERE telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  v_expires := NOW() + make_interval(mins => p_expiry_minutes);
  FOR v_attempt IN 1..30 LOOP
    v_id := gen_random_uuid();
    v_code := 'D' || substring(replace(v_id::TEXT, '-', '') FROM 1 FOR 24);
    IF p_method = 'usdt_trc20' THEN
      v_expected := round(p_requested_amount + ((floor(random() * 999) + 1)::NUMERIC / 1000000), 6);
    ELSE
      v_expected := p_requested_amount;
    END IF;
    BEGIN
      RETURN QUERY
      INSERT INTO deposits(
        id, deposit_code, user_id, requested_amount, expected_amount, currency, network,
        payment_method, payment_address, expires_at
      ) VALUES (
        v_id, v_code, v_user.id, p_requested_amount, v_expected, 'USDT',
        CASE WHEN p_method = 'usdt_trc20' THEN 'TRC20' ELSE NULL END,
        p_method, p_payment_address, v_expires
      ) RETURNING deposits.id, deposits.deposit_code::TEXT, deposits.requested_amount,
        deposits.expected_amount, deposits.currency::TEXT, deposits.payment_method::TEXT,
        deposits.payment_address, deposits.status::TEXT, deposits.expires_at;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt = 30 THEN RAISE EXCEPTION 'DEPOSIT_RESERVATION_BUSY'; END IF;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION attach_binance_order(
  p_deposit_id UUID,
  p_provider_order_id TEXT,
  p_provider_prepay_id TEXT,
  p_checkout_url TEXT,
  p_expires_at TIMESTAMPTZ
) RETURNS SETOF deposits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE deposits SET
    provider_order_id = p_provider_order_id,
    provider_prepay_id = p_provider_prepay_id,
    checkout_url = p_checkout_url,
    expires_at = LEAST(expires_at, p_expires_at),
    updated_at = NOW()
  WHERE id = p_deposit_id AND payment_method = 'binance' AND status = 'pending'
  RETURNING deposits.*;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_PENDING'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION cancel_deposit(p_telegram_id BIGINT, p_deposit_id UUID)
RETURNS TABLE(id UUID, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE;
BEGIN
  SELECT d.* INTO v_deposit FROM deposits d JOIN users u ON u.id = d.user_id
    WHERE d.id = p_deposit_id AND u.telegram_id = p_telegram_id FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  IF v_deposit.status <> 'pending' THEN
    RETURN QUERY SELECT v_deposit.id, v_deposit.status::TEXT;
    RETURN;
  END IF;
  UPDATE deposits SET status = 'cancelled', reservation_active = FALSE, updated_at = NOW()
    WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT p_deposit_id, 'cancelled'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION submit_usdt_txid(
  p_telegram_id BIGINT,
  p_deposit_id UUID,
  p_transaction_id TEXT
) RETURNS TABLE(
  id UUID, deposit_code TEXT, telegram_id BIGINT, username TEXT,
  requested_amount NUMERIC, expected_amount NUMERIC, payment_address TEXT,
  transaction_id TEXT, status TEXT, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE;
BEGIN
  IF p_transaction_id !~ '^[A-Fa-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_TXID'; END IF;
  IF EXISTS (SELECT 1 FROM deposits d WHERE d.transaction_id = lower(p_transaction_id) AND d.id <> p_deposit_id) THEN
    RAISE EXCEPTION 'DUPLICATE_TXID';
  END IF;
  SELECT d.* INTO v_deposit
  FROM deposits d JOIN users u ON u.id = d.user_id
  WHERE d.id = p_deposit_id AND u.telegram_id = p_telegram_id FOR UPDATE OF d;
  IF NOT FOUND OR v_deposit.payment_method <> 'usdt_trc20' THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id;
  IF v_deposit.expires_at <= NOW() THEN
    UPDATE deposits SET status = 'expired', reservation_active = FALSE, updated_at = NOW() WHERE deposits.id = p_deposit_id;
    RETURN QUERY SELECT v_deposit.id, v_deposit.deposit_code::TEXT, v_user.telegram_id, v_user.username,
      v_deposit.requested_amount, v_deposit.expected_amount, v_deposit.payment_address,
      v_deposit.transaction_id, 'expired'::TEXT, v_deposit.created_at, v_deposit.expires_at;
    RETURN;
  END IF;
  IF v_deposit.status <> 'pending' OR v_deposit.transaction_id IS NOT NULL THEN RAISE EXCEPTION 'DEPOSIT_NOT_PENDING'; END IF;
  UPDATE deposits SET transaction_id = lower(p_transaction_id), status = 'pending_review', updated_at = NOW()
    WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_deposit.deposit_code::TEXT, v_user.telegram_id, v_user.username,
    v_deposit.requested_amount, v_deposit.expected_amount, v_deposit.payment_address,
    lower(p_transaction_id), 'pending_review'::TEXT, v_deposit.created_at, v_deposit.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION approve_manual_deposit(p_deposit_id UUID, p_admin_telegram_id BIGINT)
RETURNS TABLE(id UUID, telegram_id BIGINT, amount NUMERIC, status TEXT, credited BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE; v_balance NUMERIC(20,8);
BEGIN
  SELECT * INTO v_deposit FROM deposits WHERE deposits.id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id FOR UPDATE;
  IF v_deposit.status = 'approved' THEN
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.expires_at <= NOW() THEN
    UPDATE deposits SET status = 'expired', reservation_active = FALSE, reviewed_at = NOW(),
      approved_by = p_admin_telegram_id, updated_at = NOW() WHERE deposits.id = p_deposit_id;
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'expired'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.payment_method <> 'usdt_trc20' OR v_deposit.status <> 'pending_review' OR v_deposit.transaction_id IS NULL THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_REVIEWABLE';
  END IF;
  UPDATE users SET wallet_balance = wallet_balance + v_deposit.expected_amount, updated_at = NOW()
    WHERE users.id = v_user.id RETURNING wallet_balance INTO v_balance;
  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', v_deposit.expected_amount, v_balance, 'deposit', v_deposit.id::TEXT, 'USDT TRC20 deposit');
  UPDATE deposits SET status = 'approved', reservation_active = FALSE, paid_at = NOW(), approved_at = NOW(),
    reviewed_at = NOW(), approved_by = p_admin_telegram_id, updated_at = NOW() WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION reject_deposit(p_deposit_id UUID, p_admin_telegram_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS TABLE(id UUID, telegram_id BIGINT, amount NUMERIC, status TEXT, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_deposit FROM deposits WHERE deposits.id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id;
  IF v_deposit.status IN ('approved', 'rejected', 'expired', 'cancelled') THEN
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, v_deposit.status::TEXT, FALSE;
    RETURN;
  END IF;
  UPDATE deposits SET status = 'rejected', reservation_active = FALSE, reviewed_at = NOW(),
    approved_by = p_admin_telegram_id, rejection_reason = p_reason, updated_at = NOW()
    WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'rejected'::TEXT, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION approve_binance_deposit(
  p_provider_order_id TEXT,
  p_provider_prepay_id TEXT,
  p_provider_transaction_id TEXT,
  p_amount NUMERIC,
  p_currency TEXT,
  p_paid_at TIMESTAMPTZ
) RETURNS TABLE(id UUID, telegram_id BIGINT, amount NUMERIC, status TEXT, credited BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE; v_balance NUMERIC(20,8);
BEGIN
  SELECT * INTO v_deposit FROM deposits WHERE provider_order_id = p_provider_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BINANCE_ORDER_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id FOR UPDATE;
  IF v_deposit.status = 'approved' THEN
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.payment_method <> 'binance' OR v_deposit.status <> 'pending' THEN RAISE EXCEPTION 'DEPOSIT_NOT_PENDING'; END IF;
  IF v_deposit.provider_prepay_id IS DISTINCT FROM p_provider_prepay_id THEN RAISE EXCEPTION 'BINANCE_PREPAY_MISMATCH'; END IF;
  IF v_deposit.expected_amount <> p_amount THEN RAISE EXCEPTION 'BINANCE_AMOUNT_MISMATCH'; END IF;
  IF upper(v_deposit.currency) <> upper(p_currency) THEN RAISE EXCEPTION 'BINANCE_CURRENCY_MISMATCH'; END IF;
  IF p_paid_at > v_deposit.expires_at THEN RAISE EXCEPTION 'BINANCE_PAYMENT_EXPIRED'; END IF;
  IF p_provider_transaction_id IS NULL OR p_provider_transaction_id = '' THEN RAISE EXCEPTION 'BINANCE_TRANSACTION_MISSING'; END IF;

  UPDATE users SET wallet_balance = wallet_balance + v_deposit.expected_amount, updated_at = NOW()
    WHERE users.id = v_user.id RETURNING wallet_balance INTO v_balance;
  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', v_deposit.expected_amount, v_balance, 'deposit', v_deposit.id::TEXT, 'Binance Pay deposit');
  UPDATE deposits SET status = 'approved', reservation_active = FALSE,
    transaction_id = p_provider_transaction_id, provider_transaction_id = p_provider_transaction_id,
    paid_at = p_paid_at, approved_at = NOW(), updated_at = NOW()
    WHERE deposits.id = v_deposit.id;
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, TRUE;
END;
$$;



CREATE OR REPLACE FUNCTION approve_binance_history_deposit(
  p_deposit_id UUID,
  p_provider_transaction_id TEXT,
  p_received_amount NUMERIC,
  p_currency TEXT,
  p_paid_at TIMESTAMPTZ
) RETURNS TABLE(
  id UUID, telegram_id BIGINT, expected_amount NUMERIC, amount NUMERIC,
  currency TEXT, status TEXT, credited BOOLEAN, amount_matches BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deposit deposits%ROWTYPE;
  v_user users%ROWTYPE;
  v_balance NUMERIC(20,8);
BEGIN
  IF p_provider_transaction_id IS NULL OR btrim(p_provider_transaction_id) = '' THEN
    RAISE EXCEPTION 'BINANCE_TRANSACTION_MISSING';
  END IF;
  IF p_received_amount IS NULL OR p_received_amount <= 0 THEN
    RAISE EXCEPTION 'BINANCE_AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_deposit FROM deposits WHERE deposits.id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id FOR UPDATE;

  IF v_deposit.status = 'approved' THEN
    IF v_deposit.provider_transaction_id = p_provider_transaction_id OR v_deposit.transaction_id = p_provider_transaction_id THEN
      RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount,
        COALESCE(v_deposit.received_amount, v_deposit.expected_amount), v_deposit.currency::TEXT,
        'approved'::TEXT, FALSE,
        COALESCE(v_deposit.received_amount, v_deposit.expected_amount) = v_deposit.expected_amount;
      RETURN;
    END IF;
    RAISE EXCEPTION 'DEPOSIT_NOT_PENDING';
  END IF;

  IF v_deposit.payment_method <> 'binance' OR v_deposit.status NOT IN ('pending', 'expired') THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_PENDING';
  END IF;
  IF upper(v_deposit.currency) <> upper(p_currency) THEN RAISE EXCEPTION 'BINANCE_CURRENCY_MISMATCH'; END IF;
  IF p_paid_at > v_deposit.expires_at THEN RAISE EXCEPTION 'BINANCE_PAYMENT_EXPIRED'; END IF;
  IF p_paid_at < v_deposit.created_at - INTERVAL '2 minutes' THEN RAISE EXCEPTION 'BINANCE_PAYMENT_TOO_EARLY'; END IF;

  IF EXISTS (
    SELECT 1 FROM deposits d
    WHERE d.id <> v_deposit.id
      AND (d.provider_transaction_id = p_provider_transaction_id OR d.transaction_id = p_provider_transaction_id)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_BINANCE_TRANSACTION';
  END IF;

  UPDATE users SET wallet_balance = wallet_balance + p_received_amount, updated_at = NOW()
  WHERE users.id = v_user.id RETURNING wallet_balance INTO v_balance;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', p_received_amount, v_balance, 'deposit', v_deposit.id::TEXT, 'Binance Pay deposit');

  UPDATE deposits SET status = 'approved', reservation_active = FALSE,
    received_amount = p_received_amount,
    transaction_id = p_provider_transaction_id,
    provider_transaction_id = p_provider_transaction_id,
    paid_at = p_paid_at, approved_at = NOW(), updated_at = NOW()
  WHERE deposits.id = v_deposit.id;

  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount,
    p_received_amount, v_deposit.currency::TEXT, 'approved'::TEXT, TRUE,
    p_received_amount = v_deposit.expected_amount;
END;
$$;

CREATE OR REPLACE FUNCTION expire_deposits()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE deposits SET status = 'expired', reservation_active = FALSE, updated_at = NOW()
  WHERE status IN ('pending', 'pending_review') AND expires_at <= NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_states ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON TABLE subscriptions, users, categories, products, orders, deposits, wallet_transactions, notifications, bot_states TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION ensure_bot_user(BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_product(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_deposit(BIGINT, TEXT, NUMERIC, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION attach_binance_order(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_deposit(BIGINT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_usdt_txid(BIGINT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_manual_deposit(UUID, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_deposit(UUID, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_binance_deposit(TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_binance_history_deposit(UUID, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_deposits() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ensure_bot_user(BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION purchase_product(BIGINT, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION create_deposit(BIGINT, TEXT, NUMERIC, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION attach_binance_order(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION cancel_deposit(BIGINT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION submit_usdt_txid(BIGINT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_manual_deposit(UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION reject_deposit(UUID, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_binance_deposit(TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION approve_binance_history_deposit(UUID, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION expire_deposits() TO service_role;

-- ==========================================================================
-- Production upgrade v3: unique inventory, manual fulfillment, refunds, live
-- admin data and richer product/order snapshots. This section is intentionally
-- additive and safe to run over an existing installation.
-- ==========================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS full_description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE products ADD COLUMN IF NOT EXISTS delivery_time_label TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_value INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_unit TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_preorder BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS max_quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manual_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unlimited_stock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS bulk_pricing_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS emoji TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS public_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE products ALTER COLUMN delivery_text SET DEFAULT '';

UPDATE products SET
  short_description = CASE WHEN short_description = '' THEN left(description, 240) ELSE short_description END,
  full_description = CASE WHEN full_description = '' THEN description ELSE full_description END,
  fulfillment_type = CASE WHEN fulfillment_type IN ('instant', 'manual') THEN fulfillment_type ELSE 'manual' END,
  manual_stock = CASE WHEN manual_stock = 0 THEN stock ELSE manual_stock END,
  max_quantity = GREATEST(max_quantity, min_quantity, 1)
WHERE short_description = '' OR full_description = '' OR fulfillment_type NOT IN ('instant', 'manual')
   OR (manual_stock = 0 AND stock > 0) OR max_quantity < min_quantity;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_fulfillment_type_check;
ALTER TABLE products ADD CONSTRAINT products_fulfillment_type_check CHECK (fulfillment_type IN ('instant', 'manual'));
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_warranty_check;
ALTER TABLE products ADD CONSTRAINT products_warranty_check CHECK (
  (warranty_value IS NULL AND warranty_unit IS NULL) OR
  (warranty_value BETWEEN 1 AND 10000 AND warranty_unit IN ('hours', 'days', 'months'))
);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_quantity_check;
ALTER TABLE products ADD CONSTRAINT products_quantity_check CHECK (
  min_quantity >= 1 AND max_quantity >= min_quantity AND max_quantity <= 1000 AND manual_stock >= 0
);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS unit_price NUMERIC(20,8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC(20,8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_time_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS warranty_value_snapshot INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS warranty_unit_snapshot TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_instructions_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_by BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_ciphertext TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_iv TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_auth_tag TEXT;
ALTER TABLE orders ALTER COLUMN delivery_data SET DEFAULT '';

UPDATE orders SET
  status = CASE WHEN status = 'completed' THEN 'delivered' ELSE status END,
  unit_price = COALESCE(unit_price, amount),
  total_amount = COALESCE(total_amount, amount),
  quantity = GREATEST(quantity, 1),
  delivered_at = CASE WHEN status IN ('completed', 'delivered') THEN COALESCE(delivered_at, created_at) ELSE delivered_at END
WHERE status = 'completed' OR unit_price IS NULL OR total_amount IS NULL OR quantity < 1;

ALTER TABLE orders ALTER COLUMN unit_price SET NOT NULL;
ALTER TABLE orders ALTER COLUMN total_amount SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
  status IN ('pending', 'processing', 'delivered', 'refunded', 'cancelled')
);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_quantity_check;
ALTER TABLE orders ADD CONSTRAINT orders_quantity_check CHECK (quantity >= 1 AND unit_price >= 0 AND total_amount >= 0);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfillment_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_fulfillment_type_check CHECK (fulfillment_type IN ('instant', 'manual'));

CREATE TABLE IF NOT EXISTS bulk_pricing_tiers (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_quantity INTEGER NOT NULL CHECK (min_quantity >= 1),
  max_quantity INTEGER CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
  unit_price NUMERIC(20,8) NOT NULL CHECK (unit_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_id, min_quantity)
);

CREATE TABLE IF NOT EXISTS product_inventory_items (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_auth_tag TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold', 'disabled')),
  order_id BIGINT REFERENCES orders(id) ON DELETE RESTRICT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reserved_at TIMESTAMPTZ,
  sold_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_id, payload_hash),
  CHECK ((status = 'sold' AND order_id IS NOT NULL AND sold_at IS NOT NULL) OR status <> 'sold')
);

CREATE TABLE IF NOT EXISTS refund_requests (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT,
  admin_note TEXT
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_telegram_id BIGINT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_open_order
  ON refund_requests(order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inventory_product_status
  ON product_inventory_items(product_id, status, id);
CREATE INDEX IF NOT EXISTS idx_inventory_order ON product_inventory_items(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bulk_tiers_product ON bulk_pricing_tiers(product_id, min_quantity DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_status ON orders(fulfillment_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_status_created ON refund_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);

CREATE OR REPLACE FUNCTION sync_instant_product_stock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_product_id BIGINT;
BEGIN
  v_product_id := COALESCE(NEW.product_id, OLD.product_id);
  UPDATE products p SET stock = (
    SELECT count(*)::INTEGER FROM product_inventory_items i
    WHERE i.product_id = v_product_id AND i.status = 'available'
  ), updated_at = NOW()
  WHERE p.id = v_product_id AND p.fulfillment_type = 'instant';
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_instant_product_stock ON product_inventory_items;
CREATE TRIGGER trg_sync_instant_product_stock
AFTER INSERT OR UPDATE OR DELETE ON product_inventory_items
FOR EACH ROW EXECUTE FUNCTION sync_instant_product_stock();

DROP VIEW IF EXISTS category_catalog;
DROP VIEW IF EXISTS product_catalog;
CREATE VIEW product_catalog AS
SELECT p.*,
  CASE WHEN p.fulfillment_type = 'instant' THEN
    (SELECT count(*)::INTEGER FROM product_inventory_items i WHERE i.product_id = p.id AND i.status = 'available')
  WHEN p.unlimited_stock THEN NULL ELSE p.manual_stock END AS available_stock,
  COALESCE((SELECT sum(o.quantity)::BIGINT FROM orders o WHERE o.product_id = p.id AND o.status = 'delivered'), 0) AS sold_count,
  (SELECT c.name FROM categories c WHERE c.id = p.category_id) AS category_name
FROM products p;

CREATE VIEW category_catalog AS
SELECT c.*,
  (SELECT count(*)::INTEGER FROM product_catalog p
   WHERE p.category_id = c.id AND p.active = TRUE
     AND (p.allow_preorder OR p.unlimited_stock OR COALESCE(p.available_stock, 0) > 0)) AS available_product_count,
  (SELECT count(*)::INTEGER FROM products p WHERE p.category_id = c.id AND p.active = TRUE) AS active_product_count
FROM categories c;

REVOKE ALL ON product_catalog, category_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON product_catalog, category_catalog TO service_role;

CREATE OR REPLACE FUNCTION purchase_product_v2(
  p_telegram_id BIGINT,
  p_product_id BIGINT,
  p_quantity INTEGER,
  p_idempotency_key TEXT
) RETURNS TABLE(
  order_id BIGINT, product_name TEXT, quantity INTEGER, unit_price NUMERIC,
  total_amount NUMERIC, status TEXT, fulfillment_type TEXT,
  delivery_time TEXT, warranty_value INTEGER, warranty_unit TEXT,
  public_instructions TEXT, payload_ciphertexts TEXT[], payload_ivs TEXT[],
  payload_auth_tags TEXT[], already_processed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_product products%ROWTYPE;
  v_order orders%ROWTYPE;
  v_unit_price NUMERIC(20,8);
  v_total NUMERIC(20,8);
  v_balance NUMERIC(20,8);
  v_item_ids BIGINT[];
  v_item_count INTEGER;
  v_updated_count INTEGER;
  v_ciphertexts TEXT[];
  v_ivs TEXT[];
  v_tags TEXT[];
  v_order_owner BIGINT;
BEGIN
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 1000 THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  SELECT o.* INTO v_order FROM orders o WHERE o.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT u.telegram_id INTO v_order_owner FROM users u WHERE u.id = v_order.user_id;
    IF v_order_owner <> p_telegram_id OR v_order.product_id <> p_product_id OR v_order.quantity <> p_quantity THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    SELECT array_agg(i.payload_ciphertext ORDER BY i.id), array_agg(i.payload_iv ORDER BY i.id),
      array_agg(i.payload_auth_tag ORDER BY i.id)
    INTO v_ciphertexts, v_ivs, v_tags FROM product_inventory_items i WHERE i.order_id = v_order.id AND i.status = 'sold';
    IF v_order.fulfillment_type = 'instant' AND v_order.status = 'delivered' AND
       (cardinality(COALESCE(v_ciphertexts, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_ivs, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_tags, ARRAY[]::TEXT[])) <> v_order.quantity) THEN
      RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH';
    END IF;
    RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.quantity, v_order.unit_price,
      v_order.total_amount, v_order.status::TEXT, v_order.fulfillment_type::TEXT,
      v_order.delivery_time_snapshot, v_order.warranty_value_snapshot, v_order.warranty_unit_snapshot,
      v_order.public_instructions_snapshot, COALESCE(v_ciphertexts, ARRAY[]::TEXT[]),
      COALESCE(v_ivs, ARRAY[]::TEXT[]), COALESCE(v_tags, ARRAY[]::TEXT[]), TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_user FROM users u WHERE u.telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  -- Recheck after the user lock so simultaneous retries return the first order
  -- instead of surfacing the unique-index race to the client.
  SELECT * INTO v_order FROM orders o WHERE o.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_order.user_id <> v_user.id OR v_order.product_id <> p_product_id OR v_order.quantity <> p_quantity THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    SELECT array_agg(i.payload_ciphertext ORDER BY i.id), array_agg(i.payload_iv ORDER BY i.id),
      array_agg(i.payload_auth_tag ORDER BY i.id)
    INTO v_ciphertexts, v_ivs, v_tags FROM product_inventory_items i WHERE i.order_id = v_order.id AND i.status = 'sold';
    IF v_order.fulfillment_type = 'instant' AND v_order.status = 'delivered' AND
       (cardinality(COALESCE(v_ciphertexts, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_ivs, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_tags, ARRAY[]::TEXT[])) <> v_order.quantity) THEN
      RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH';
    END IF;
    RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.quantity, v_order.unit_price,
      v_order.total_amount, v_order.status::TEXT, v_order.fulfillment_type::TEXT,
      v_order.delivery_time_snapshot, v_order.warranty_value_snapshot, v_order.warranty_unit_snapshot,
      v_order.public_instructions_snapshot, COALESCE(v_ciphertexts, ARRAY[]::TEXT[]),
      COALESCE(v_ivs, ARRAY[]::TEXT[]), COALESCE(v_tags, ARRAY[]::TEXT[]), TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_product FROM products p WHERE p.id = p_product_id FOR UPDATE;
  IF NOT FOUND OR NOT v_product.active THEN RAISE EXCEPTION 'PRODUCT_UNAVAILABLE'; END IF;
  IF p_quantity < v_product.min_quantity OR p_quantity > v_product.max_quantity THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;

  v_unit_price := v_product.price;
  IF v_product.bulk_pricing_enabled THEN
    SELECT t.unit_price INTO v_unit_price FROM bulk_pricing_tiers t
    WHERE t.product_id = v_product.id AND t.min_quantity <= p_quantity
      AND (t.max_quantity IS NULL OR t.max_quantity >= p_quantity)
    ORDER BY t.min_quantity DESC LIMIT 1;
    v_unit_price := COALESCE(v_unit_price, v_product.price);
  END IF;
  v_total := v_unit_price * p_quantity;
  IF v_user.wallet_balance < v_total THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;

  IF v_product.fulfillment_type = 'instant' THEN
    SELECT array_agg(s.id ORDER BY s.id), count(*)::INTEGER INTO v_item_ids, v_item_count
    FROM (
      SELECT i.id FROM product_inventory_items i
      WHERE i.product_id = v_product.id AND i.status = 'available' AND i.order_id IS NULL
      ORDER BY i.id FOR UPDATE SKIP LOCKED LIMIT p_quantity
    ) s;
    IF COALESCE(v_item_count, 0) <> p_quantity THEN RAISE EXCEPTION 'OUT_OF_STOCK'; END IF;
  ELSE
    IF NOT v_product.unlimited_stock AND v_product.manual_stock < p_quantity AND NOT v_product.allow_preorder THEN
      RAISE EXCEPTION 'OUT_OF_STOCK';
    END IF;
    IF NOT v_product.unlimited_stock THEN
      UPDATE products SET manual_stock = GREATEST(manual_stock - p_quantity, 0),
        stock = GREATEST(stock - p_quantity, 0), updated_at = NOW()
      WHERE id = v_product.id;
    END IF;
  END IF;

  UPDATE users SET wallet_balance = wallet_balance - v_total, updated_at = NOW()
  WHERE id = v_user.id AND wallet_balance >= v_total RETURNING wallet_balance INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;

  INSERT INTO orders(
    user_id, product_id, product_name, amount, status, delivery_data, idempotency_key,
    quantity, unit_price, total_amount, fulfillment_type, delivery_time_snapshot,
    warranty_value_snapshot, warranty_unit_snapshot, public_instructions_snapshot,
    payment_method, delivered_at
  ) VALUES (
    v_user.id, v_product.id, v_product.name, v_total,
    CASE WHEN v_product.fulfillment_type = 'instant' THEN 'delivered' ELSE 'processing' END,
    '', p_idempotency_key, p_quantity, v_unit_price, v_total, v_product.fulfillment_type,
    v_product.delivery_time_label, v_product.warranty_value, v_product.warranty_unit,
    v_product.public_instructions, 'wallet',
    CASE WHEN v_product.fulfillment_type = 'instant' THEN NOW() ELSE NULL END
  ) RETURNING * INTO v_order;

  IF v_product.fulfillment_type = 'instant' THEN
    UPDATE product_inventory_items SET status = 'sold', order_id = v_order.id,
      sold_at = NOW(), reserved_at = NULL, updated_at = NOW()
    WHERE product_inventory_items.id = ANY(v_item_ids) AND product_inventory_items.product_id = v_product.id AND product_inventory_items.status = 'available' AND product_inventory_items.order_id IS NULL;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> p_quantity THEN RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH'; END IF;
    SELECT array_agg(i.payload_ciphertext ORDER BY i.id), array_agg(i.payload_iv ORDER BY i.id),
      array_agg(i.payload_auth_tag ORDER BY i.id)
    INTO v_ciphertexts, v_ivs, v_tags FROM product_inventory_items i WHERE i.order_id = v_order.id AND i.status = 'sold';
    IF cardinality(COALESCE(v_ciphertexts, ARRAY[]::TEXT[])) <> p_quantity OR
       cardinality(COALESCE(v_ivs, ARRAY[]::TEXT[])) <> p_quantity OR
       cardinality(COALESCE(v_tags, ARRAY[]::TEXT[])) <> p_quantity THEN
      RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH';
    END IF;
  END IF;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'purchase', -v_total, v_balance, 'order', v_order.id::TEXT, v_product.name);

  RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.quantity, v_order.unit_price,
    v_order.total_amount, v_order.status::TEXT, v_order.fulfillment_type::TEXT,
    v_order.delivery_time_snapshot, v_order.warranty_value_snapshot, v_order.warranty_unit_snapshot,
    v_order.public_instructions_snapshot, COALESCE(v_ciphertexts, ARRAY[]::TEXT[]),
    COALESCE(v_ivs, ARRAY[]::TEXT[]), COALESCE(v_tags, ARRAY[]::TEXT[]), FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION deliver_manual_order(
  p_order_id BIGINT,
  p_admin_telegram_id BIGINT,
  p_delivery_ciphertext TEXT,
  p_delivery_iv TEXT,
  p_delivery_auth_tag TEXT
) RETURNS TABLE(order_id BIGINT, telegram_id BIGINT, product_name TEXT, status TEXT, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order orders%ROWTYPE; v_telegram_id BIGINT;
BEGIN
  SELECT * INTO v_order FROM orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  SELECT u.telegram_id INTO v_telegram_id FROM users u WHERE u.id = v_order.user_id;
  IF v_order.status = 'delivered' THEN
    RETURN QUERY SELECT v_order.id, v_telegram_id, v_order.product_name, 'delivered'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_order.fulfillment_type <> 'manual' OR v_order.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'ORDER_NOT_DELIVERABLE';
  END IF;
  IF COALESCE(p_delivery_ciphertext, '') = '' OR COALESCE(p_delivery_iv, '') = '' OR COALESCE(p_delivery_auth_tag, '') = '' THEN
    RAISE EXCEPTION 'DELIVERY_REQUIRED';
  END IF;
  UPDATE orders SET status = 'delivered', delivery_ciphertext = p_delivery_ciphertext,
    delivery_iv = p_delivery_iv, delivery_auth_tag = p_delivery_auth_tag,
    delivered_at = NOW(), delivered_by = p_admin_telegram_id
  WHERE id = p_order_id;
  RETURN QUERY SELECT v_order.id, v_telegram_id, v_order.product_name, 'delivered'::TEXT, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION create_refund_request(
  p_telegram_id BIGINT,
  p_order_id BIGINT,
  p_reason TEXT
) RETURNS SETOF refund_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user users%ROWTYPE; v_order orders%ROWTYPE; v_deadline TIMESTAMPTZ;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'INVALID_REFUND_REASON'; END IF;
  SELECT * INTO v_user FROM users u WHERE u.telegram_id = p_telegram_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  SELECT * INTO v_order FROM orders o WHERE o.id = p_order_id AND o.user_id = v_user.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status NOT IN ('processing', 'delivered') THEN RAISE EXCEPTION 'REFUND_NOT_ELIGIBLE'; END IF;
  IF EXISTS (SELECT 1 FROM refund_requests r WHERE r.order_id = v_order.id AND r.status = 'pending') THEN
    RAISE EXCEPTION 'REFUND_ALREADY_OPEN';
  END IF;
  IF v_order.status = 'delivered' THEN
    v_deadline := COALESCE(v_order.delivered_at, v_order.created_at) +
      CASE v_order.warranty_unit_snapshot
        WHEN 'hours' THEN make_interval(hours => COALESCE(v_order.warranty_value_snapshot, 24))
        WHEN 'days' THEN make_interval(days => COALESCE(v_order.warranty_value_snapshot, 1))
        WHEN 'months' THEN make_interval(months => COALESCE(v_order.warranty_value_snapshot, 1))
        ELSE interval '24 hours'
      END;
    IF NOW() > v_deadline THEN RAISE EXCEPTION 'REFUND_WINDOW_EXPIRED'; END IF;
  END IF;
  RETURN QUERY INSERT INTO refund_requests(order_id, user_id, reason)
    VALUES (v_order.id, v_user.id, trim(p_reason)) RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION review_refund_request(
  p_request_id BIGINT,
  p_admin_telegram_id BIGINT,
  p_decision TEXT,
  p_admin_note TEXT DEFAULT NULL
) RETURNS TABLE(request_id BIGINT, order_id BIGINT, telegram_id BIGINT, amount NUMERIC, status TEXT, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_request refund_requests%ROWTYPE; v_order orders%ROWTYPE; v_user users%ROWTYPE; v_balance NUMERIC(20,8);
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'INVALID_REFUND_DECISION'; END IF;
  SELECT * INTO v_request FROM refund_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  SELECT * INTO v_order FROM orders o WHERE o.id = v_request.order_id FOR UPDATE;
  SELECT * INTO v_user FROM users u WHERE u.id = v_request.user_id FOR UPDATE;
  IF v_request.status <> 'pending' THEN
    RETURN QUERY SELECT v_request.id, v_order.id, v_user.telegram_id, v_order.total_amount,
      v_request.status::TEXT, FALSE;
    RETURN;
  END IF;
  IF p_decision = 'approved' THEN
    IF v_order.status = 'refunded' THEN RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED'; END IF;
    IF v_order.status NOT IN ('processing', 'delivered') THEN RAISE EXCEPTION 'REFUND_NOT_ELIGIBLE'; END IF;
    UPDATE users SET wallet_balance = wallet_balance + v_order.total_amount, updated_at = NOW()
      WHERE id = v_user.id RETURNING wallet_balance INTO v_balance;
    UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = v_order.id;
    INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
    VALUES (v_user.id, 'refund', v_order.total_amount, v_balance, 'refund', v_request.id::TEXT, 'Refund for order #' || v_order.id);
  END IF;
  UPDATE refund_requests SET status = p_decision, reviewed_at = NOW(), reviewed_by = p_admin_telegram_id,
    admin_note = left(COALESCE(p_admin_note, ''), 2000) WHERE id = v_request.id;
  RETURN QUERY SELECT v_request.id, v_order.id, v_user.telegram_id, v_order.total_amount, p_decision, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION user_order_summary(
  p_telegram_id BIGINT,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(total BIGINT, delivered BIGINT, spent NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::BIGINT,
    count(*) FILTER (WHERE o.status = 'delivered')::BIGINT,
    COALESCE(sum(o.total_amount) FILTER (WHERE o.status NOT IN ('refunded', 'cancelled')), 0)::NUMERIC
  FROM orders o JOIN users u ON u.id = o.user_id
  WHERE u.telegram_id = p_telegram_id
    AND (p_from IS NULL OR o.created_at >= p_from)
    AND (p_to IS NULL OR o.created_at < p_to);
$$;

CREATE OR REPLACE FUNCTION replace_bulk_pricing_tiers(p_product_id BIGINT, p_tiers JSONB)
RETURNS SETOF bulk_pricing_tiers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' OR jsonb_array_length(p_tiers) > 20 THEN
    RAISE EXCEPTION 'INVALID_BULK_TIERS';
  END IF;
  PERFORM 1 FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
  DELETE FROM bulk_pricing_tiers WHERE product_id = p_product_id;
  RETURN QUERY
  INSERT INTO bulk_pricing_tiers(product_id, min_quantity, max_quantity, unit_price)
  SELECT p_product_id, x.min_quantity, x.max_quantity, x.unit_price
  FROM jsonb_to_recordset(p_tiers) AS x(min_quantity INTEGER, max_quantity INTEGER, unit_price NUMERIC)
  RETURNING *;
END;
$$;

ALTER TABLE bulk_pricing_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON product_catalog, category_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON product_catalog, category_catalog TO service_role;
GRANT ALL ON bulk_pricing_tiers, product_inventory_items, refund_requests, admin_audit_log TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION purchase_product_v2(BIGINT, BIGINT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION deliver_manual_order(BIGINT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_refund_request(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION review_refund_request(BIGINT, BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION user_order_summary(BIGINT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION replace_bulk_pricing_tiers(BIGINT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purchase_product_v2(BIGINT, BIGINT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION deliver_manual_order(BIGINT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION create_refund_request(BIGINT, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION review_refund_request(BIGINT, BIGINT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION user_order_summary(BIGINT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION replace_bulk_pricing_tiers(BIGINT, JSONB) TO service_role;

-- Supabase Realtime. If the publication is unavailable in a restricted project,
-- the admin client automatically falls back to authenticated polling.
DO $$
DECLARE v_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['users','products','categories','product_inventory_items','bulk_pricing_tiers','orders','deposits','wallet_transactions','notifications','refund_requests']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ============================================================================
-- Production upgrade v4: dynamic bot content, links, FAQ, support inbox,
-- payment display settings, richer catalog metadata and category controls.
-- Additive/backward-compatible: no existing application tables are dropped.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS emoji TEXT NOT NULL DEFAULT '';

ALTER TABLE products ADD COLUMN IF NOT EXISTS subtitle TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS duration TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE products ADD COLUMN IF NOT EXISTS sold_display_offset BIGINT NOT NULL DEFAULT 0;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_status_check;
ALTER TABLE products ADD CONSTRAINT products_product_status_check CHECK (product_status IN ('active','inactive','out_of_stock','draft'));
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_currency_check;
ALTER TABLE products ADD CONSTRAINT products_currency_check CHECK (currency ~ '^[A-Z]{3,10}$');

UPDATE products SET product_status = CASE WHEN active THEN 'active' ELSE 'inactive' END
WHERE product_status IS NULL OR product_status NOT IN ('active','inactive','out_of_stock','draft');

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);

INSERT INTO bot_settings(key,value,description,is_public) VALUES
  ('bot_name','NY Store','Bot/store display name',TRUE),
  ('welcome_message','Welcome back, {{first_name}}!','Main menu welcome line',TRUE),
  ('start_message','','Optional start message shown above the main menu',TRUE),
  ('store_description','','Store description',TRUE),
  ('currency','USD','Default display currency',TRUE),
  ('maintenance_mode','false','When true, non-admin users cannot shop',TRUE),
  ('support_text','Need help? Chat with an admin right here in the bot, or use the contact button below.','Support screen text',TRUE),
  ('about_text','Welcome to our digital products store. Fast ordering, secure wallet checkout, and clear delivery status.','About screen text',TRUE),
  ('footer','','Optional footer',TRUE),
  ('terms_text','','Terms text',TRUE),
  ('buy_button_text','🛒 Buy Now','Buy button label',TRUE),
  ('back_button_text','⬅️ Back','Back button label',TRUE),
  ('main_menu_text','☰ Menu','Main menu label',TRUE),
  ('default_language','en','Default language',TRUE),
  ('contact_information','','Contact information',TRUE),
  ('minimum_order','1','Global minimum order quantity',TRUE),
  ('maximum_order','1000','Global maximum order quantity',TRUE),
  ('payment_instructions','','Payment instructions',TRUE),
  ('order_success_message','','Optional order success suffix',TRUE),
  ('order_pending_message','','Optional pending order suffix',TRUE),
  ('out_of_stock_message','OUT OF STOCK','Out of stock text',TRUE)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS bot_links (
  id BIGSERIAL PRIMARY KEY,
  link_key TEXT NOT NULL UNIQUE,
  button_text TEXT NOT NULL,
  url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);

CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','ar','hi','all')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);

CREATE TABLE IF NOT EXISTS support_conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  unread_admin_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_admin_count >= 0),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user','admin')),
  message_text TEXT NOT NULL,
  telegram_message_id BIGINT,
  admin_telegram_id BIGINT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_last ON support_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_faqs_active_sort ON faqs(active, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_bot_links_active_sort ON bot_links(active, sort_order, id);

CREATE TABLE IF NOT EXISTS payment_settings (
  method_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  public_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);

INSERT INTO payment_settings(method_key,display_name,enabled,public_config) VALUES
  ('binance','Binance UID',TRUE,'{}'::JSONB),
  ('usdt_trc20','USDT TRC20',TRUE,'{}'::JSONB)
ON CONFLICT (method_key) DO NOTHING;

INSERT INTO categories(name, emoji, sort_order, active)
VALUES ('Other Product','📦',9999,TRUE)
ON CONFLICT (name) DO UPDATE SET emoji = CASE WHEN categories.emoji = '' THEN EXCLUDED.emoji ELSE categories.emoji END;

DROP VIEW IF EXISTS category_catalog;
DROP VIEW IF EXISTS product_catalog;
CREATE VIEW product_catalog AS
SELECT p.*,
  CASE WHEN p.fulfillment_type = 'instant' THEN
    (SELECT count(*)::INTEGER FROM product_inventory_items i WHERE i.product_id = p.id AND i.status = 'available')
  WHEN p.unlimited_stock THEN NULL ELSE p.manual_stock END AS available_stock,
  COALESCE((SELECT sum(o.quantity)::BIGINT FROM orders o WHERE o.product_id = p.id AND o.status = 'delivered'), 0) AS real_sold_count,
  GREATEST(0, COALESCE((SELECT sum(o.quantity)::BIGINT FROM orders o WHERE o.product_id = p.id AND o.status = 'delivered'), 0) + p.sold_display_offset) AS sold_count,
  (SELECT c.name FROM categories c WHERE c.id = p.category_id) AS category_name,
  (SELECT c.emoji FROM categories c WHERE c.id = p.category_id) AS category_emoji
FROM products p;

CREATE VIEW category_catalog AS
SELECT c.*,
  (SELECT count(*)::INTEGER FROM product_catalog p
   WHERE p.category_id = c.id AND p.active = TRUE AND p.product_status = 'active'
     AND (p.allow_preorder OR p.unlimited_stock OR COALESCE(p.available_stock, 0) > 0)) AS available_product_count,
  (SELECT count(*)::INTEGER FROM products p WHERE p.category_id = c.id AND p.product_status IN ('active','out_of_stock')) AS active_product_count
FROM categories c;

REVOKE ALL ON product_catalog, category_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON product_catalog, category_catalog TO service_role;

CREATE OR REPLACE FUNCTION ensure_bot_user(
  p_telegram_id BIGINT,
  p_username TEXT,
  p_first_name TEXT,
  p_default_language TEXT DEFAULT 'en',
  p_last_name TEXT DEFAULT NULL
) RETURNS SETOF users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_default_language NOT IN ('en', 'ar', 'hi') THEN p_default_language := 'en'; END IF;
  RETURN QUERY
  INSERT INTO users(telegram_id, username, first_name, last_name, language)
  VALUES (p_telegram_id, p_username, p_first_name, p_last_name, p_default_language)
  ON CONFLICT (telegram_id) DO UPDATE SET
    username = EXCLUDED.username,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    updated_at = NOW()
  RETURNING users.*;
END;
$$;

CREATE OR REPLACE FUNCTION add_support_message(
  p_telegram_id BIGINT,
  p_message TEXT,
  p_telegram_message_id BIGINT DEFAULT NULL
) RETURNS TABLE(conversation_id BIGINT, message_id BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user users%ROWTYPE; v_conversation support_conversations%ROWTYPE; v_message_id BIGINT;
BEGIN
  IF p_message IS NULL OR length(trim(p_message)) < 1 OR length(p_message) > 4000 THEN RAISE EXCEPTION 'INVALID_SUPPORT_MESSAGE'; END IF;
  SELECT * INTO v_user FROM users u WHERE u.telegram_id = p_telegram_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  INSERT INTO support_conversations(user_id,status,unread_admin_count,last_message_at,updated_at)
  VALUES(v_user.id,'open',1,NOW(),NOW())
  ON CONFLICT(user_id) DO UPDATE SET status='open', unread_admin_count=support_conversations.unread_admin_count+1,
    last_message_at=NOW(), updated_at=NOW()
  RETURNING * INTO v_conversation;
  INSERT INTO support_messages(conversation_id,sender_type,message_text,telegram_message_id)
  VALUES(v_conversation.id,'user',trim(p_message),p_telegram_message_id) RETURNING id INTO v_message_id;
  RETURN QUERY SELECT v_conversation.id, v_message_id;
END;
$$;

ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_settings ENABLE ROW LEVEL SECURITY;

GRANT ALL ON bot_settings, bot_links, faqs, support_conversations, support_messages, payment_settings TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
REVOKE ALL ON FUNCTION add_support_message(BIGINT,TEXT,BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_support_message(BIGINT,TEXT,BIGINT) TO service_role;
REVOKE ALL ON FUNCTION ensure_bot_user(BIGINT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_bot_user(BIGINT,TEXT,TEXT,TEXT,TEXT) TO service_role;

DO $$
DECLARE v_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['bot_settings','bot_links','faqs','support_conversations','support_messages','payment_settings']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_dashboard_stats()
RETURNS TABLE(
  total_revenue NUMERIC,
  total_orders BIGINT,
  completed_orders BIGINT,
  pending_orders BIGINT,
  total_users BIGINT,
  new_users_today BIGINT,
  total_products BIGINT,
  out_of_stock_products BIGINT,
  messages_waiting BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE((SELECT sum(o.total_amount) FROM orders o WHERE o.status NOT IN ('refunded','cancelled')),0)::NUMERIC,
    (SELECT count(*) FROM orders)::BIGINT,
    (SELECT count(*) FROM orders WHERE status='delivered')::BIGINT,
    (SELECT count(*) FROM orders WHERE status IN ('pending','processing'))::BIGINT,
    (SELECT count(*) FROM users)::BIGINT,
    (SELECT count(*) FROM users WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::BIGINT,
    (SELECT count(*) FROM products WHERE product_status <> 'draft')::BIGINT,
    (SELECT count(*) FROM product_catalog WHERE active=TRUE AND product_status='active' AND NOT unlimited_stock AND COALESCE(available_stock,0)=0)::BIGINT,
    COALESCE((SELECT sum(unread_admin_count)::BIGINT FROM support_conversations),0)::BIGINT;
$$;
REVOKE ALL ON FUNCTION admin_dashboard_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_dashboard_stats() TO service_role;

-- ==========================================================================
-- Production upgrade v5: nullable categories, catalog layout, persistent UI
-- state and database-backed automatic product notification queue.
-- This block is additive/idempotent and preserves existing business records.
-- ==========================================================================

ALTER TABLE products ALTER COLUMN category_id DROP NOT NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS layout_override TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_layout_override_check;
ALTER TABLE categories ADD CONSTRAINT categories_layout_override_check
  CHECK (layout_override IN ('inherit','full','two'));

ALTER TABLE products ADD COLUMN IF NOT EXISTS notification_mode TEXT NOT NULL DEFAULT 'global';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_notification_mode_check;
ALTER TABLE products ADD CONSTRAINT products_notification_mode_check
  CHECK (notification_mode IN ('global','muted'));

-- v4 created a compatibility category named 'Other Product'. v5 replaces that
-- workaround with true NULL category_id while retaining every product.
UPDATE products p
SET category_id = NULL, updated_at = NOW()
WHERE p.category_id IN (SELECT c.id FROM categories c WHERE c.name = 'Other Product');
DELETE FROM categories c
WHERE c.name = 'Other Product'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id);

INSERT INTO bot_settings(key,value,description,is_public) VALUES
  ('category_layout','full','Catalog category layout: full, two, or auto',TRUE),
  ('show_uncategorized_products','true','Show products without a category on the catalog main page',TRUE),
  ('uncategorized_section_title','📦 Other Products','Title shown above products without a category',TRUE),
  ('delete_previous_navigation_menus','true','Delete the previous Telegram navigation menu before opening a new one',TRUE),
  ('persistent_bottom_keyboard','true','Show persistent Shop and Deposit reply keyboard',TRUE),
  ('shop_button_text','🛍️ Shop','Persistent Shop button label',TRUE),
  ('deposit_button_text','➕ Deposit','Persistent Deposit button label',TRUE)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_ui_state (
  telegram_id BIGINT PRIMARY KEY,
  last_menu_message_id BIGINT,
  keyboard_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  keyboard_signature TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE user_ui_state ADD COLUMN IF NOT EXISTS keyboard_signature TEXT;
ALTER TABLE user_ui_state ADD COLUMN IF NOT EXISTS last_user_message_id BIGINT;
ALTER TABLE user_ui_state ADD COLUMN IF NOT EXISTS transient_bot_message_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[];
CREATE INDEX IF NOT EXISTS idx_user_ui_state_updated ON user_ui_state(updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_rules (
  event_type TEXT PRIMARY KEY CHECK (event_type IN ('new_product','restock','price_drop','selling_fast','out_of_stock','product_update')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  destination_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (destination_mode IN (
    'disabled','all_users','telegram_channel','telegram_group','custom_chat','users_plus_channel','users_plus_group','multiple'
  )),
  destination_value TEXT,
  selling_fast_thresholds INTEGER[] NOT NULL DEFAULT ARRAY[8,5,3],
  cooldown_minutes INTEGER NOT NULL DEFAULT 360 CHECK (cooldown_minutes BETWEEN 0 AND 10080),
  min_stock_increase INTEGER NOT NULL DEFAULT 1 CHECK (min_stock_increase >= 0),
  min_price_drop NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (min_price_drop >= 0),
  min_price_drop_percent NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (min_price_drop_percent >= 0 AND min_price_drop_percent <= 100),
  button_text TEXT NOT NULL DEFAULT '🛍️ Buy Now',
  message_template TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);

INSERT INTO notification_rules(event_type,enabled,destination_mode,button_text,message_template) VALUES
('new_product',FALSE,'disabled','🛍️ Buy Now','🆕 New Product!\n\n{{emoji}} {{name}}{{duration}}\n\n🔗 {{product_type}}\n⏱️ {{delivery_time}}\n💵 Price: {{price}}\n📦 Stock: {{stock}}\n🛡️ Warranty: {{warranty}}\n\n🔥 Available now.'),
('restock',FALSE,'disabled','🛍️ Buy Now','🎁 Back In Stock!\n\n{{emoji}} {{name}}{{duration}}\n\n💵 Price: {{price}}/item\n📦 Available now: {{stock}}\n⚡ {{delivery_time}}'),
('price_drop',FALSE,'disabled','🛍️ View New Price','🔻 Price Drop!\n\n{{emoji}} {{name}}{{duration}}\n\n💵 Now: {{price}}/item\n🏷️ Was: {{old_price}}/item\n\n{{bulk_pricing}}\n⚡ {{delivery_time}}'),
('selling_fast',FALSE,'disabled','🛍️ Buy Now','🔥 Selling Fast — Only {{stock}} Left!\n\n{{emoji}} {{name}}{{duration}}\n\n💵 Price: {{price}}/item\n\n{{bulk_pricing}}\n🎁 {{delivery_time}}: Available now ({{stock}})\n\n👉 Tap below to buy.'),
('out_of_stock',FALSE,'disabled','🛍️ View Product','❌ Out Of Stock\n\n{{emoji}} {{name}}{{duration}}\n\nThis product is currently unavailable.'),
('product_update',FALSE,'disabled','🛍️ View Product','✨ Product Updated\n\n{{emoji}} {{name}}{{duration}}\n\n💵 Price: {{price}}\n📦 Stock: {{stock}}')
ON CONFLICT (event_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS notification_destinations (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL REFERENCES notification_rules(event_type) ON DELETE CASCADE,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('users','channel','group','custom_chat')),
  target TEXT,
  label TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT,
  CHECK ((destination_type = 'users' AND target IS NULL) OR (destination_type <> 'users' AND target IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_notification_destinations_rule ON notification_destinations(event_type,enabled,id);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL REFERENCES notification_rules(event_type) ON DELETE RESTRICT,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  worker_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_queue ON notification_jobs(status,created_at) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS idx_notification_jobs_product ON notification_jobs(product_id,created_at DESC);

CREATE TABLE IF NOT EXISTS notification_job_deliveries (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  telegram_chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id,recipient_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_job_status ON notification_job_deliveries(job_id,status,id);

CREATE TABLE IF NOT EXISTS product_notification_state (
  product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  last_stock INTEGER,
  last_price NUMERIC(20,8),
  sent_thresholds INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  event_timestamps JSONB NOT NULL DEFAULT '{}'::JSONB,
  event_values JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION claim_notification_job(p_worker_id TEXT)
RETURNS SETOF notification_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id
  FROM notification_jobs
  WHERE status = 'queued' AND cancel_requested = FALSE
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  UPDATE notification_jobs
  SET status='processing', worker_id=p_worker_id, started_at=COALESCE(started_at,NOW()), last_error=NULL
  WHERE id=v_id
  RETURNING *;
END;
$$;

DROP VIEW IF EXISTS category_catalog;
DROP VIEW IF EXISTS product_catalog;
CREATE VIEW product_catalog AS
SELECT p.*,
  CASE WHEN p.fulfillment_type = 'instant' THEN
    (SELECT count(*)::INTEGER FROM product_inventory_items i WHERE i.product_id = p.id AND i.status = 'available')
  WHEN p.unlimited_stock THEN NULL ELSE p.manual_stock END AS available_stock,
  COALESCE((SELECT sum(o.quantity)::BIGINT FROM orders o WHERE o.product_id = p.id AND o.status = 'delivered'), 0) AS real_sold_count,
  GREATEST(0, COALESCE((SELECT sum(o.quantity)::BIGINT FROM orders o WHERE o.product_id = p.id AND o.status = 'delivered'), 0) + p.sold_display_offset) AS sold_count,
  (SELECT c.name FROM categories c WHERE c.id = p.category_id) AS category_name,
  (SELECT c.emoji FROM categories c WHERE c.id = p.category_id) AS category_emoji,
  (SELECT c.layout_override FROM categories c WHERE c.id = p.category_id) AS category_layout_override
FROM products p;

CREATE VIEW category_catalog AS
SELECT c.*,
  (SELECT count(*)::INTEGER FROM product_catalog p
   WHERE p.category_id = c.id AND p.active = TRUE AND p.product_status = 'active'
     AND (p.allow_preorder OR p.unlimited_stock OR COALESCE(p.available_stock, 0) > 0)) AS available_product_count,
  (SELECT count(*)::INTEGER FROM products p WHERE p.category_id = c.id AND p.product_status IN ('active','out_of_stock')) AS active_product_count
FROM categories c;

REVOKE ALL ON product_catalog, category_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON product_catalog, category_catalog TO service_role;

ALTER TABLE user_ui_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_job_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_notification_state ENABLE ROW LEVEL SECURITY;

GRANT ALL ON user_ui_state, notification_rules, notification_destinations, notification_jobs, notification_job_deliveries, product_notification_state TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
REVOKE ALL ON FUNCTION claim_notification_job(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_notification_job(TEXT) TO service_role;

DO $$
DECLARE v_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['notification_rules','notification_destinations','notification_jobs','notification_job_deliveries','product_notification_state','user_ui_state']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END $$;

-- Atomic, idempotent administrative wallet adjustment.
-- Only the server-side service_role can execute this RPC.
CREATE OR REPLACE FUNCTION admin_adjust_wallet(
  p_user_id BIGINT,
  p_delta NUMERIC,
  p_reason TEXT,
  p_admin_telegram_id BIGINT,
  p_idempotency_key UUID
) RETURNS TABLE(
  transaction_id BIGINT,
  user_id BIGINT,
  amount NUMERIC,
  balance_after NUMERIC,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_existing wallet_transactions%ROWTYPE;
  v_balance NUMERIC(20,8);
  v_transaction_id BIGINT;
  v_created_at TIMESTAMPTZ;
  v_reference_id TEXT;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 999999999999::NUMERIC THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT_AMOUNT';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 1 OR length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT_REASON';
  END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY'; END IF;

  v_reference_id := p_user_id::TEXT || ':' || p_idempotency_key::TEXT;

  SELECT * INTO v_user FROM users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;

  SELECT * INTO v_existing
  FROM wallet_transactions wt
  WHERE wt.type = 'adjustment'
    AND wt.reference_type = 'admin_adjustment'
    AND wt.reference_id = v_reference_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, v_existing.user_id, v_existing.amount, v_existing.balance_after, v_existing.created_at;
    RETURN;
  END IF;

  v_balance := v_user.wallet_balance + p_delta;
  IF v_balance < 0 THEN RAISE EXCEPTION 'NEGATIVE_WALLET_BALANCE'; END IF;

  UPDATE users
  SET wallet_balance = v_balance, updated_at = NOW()
  WHERE id = p_user_id;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (
    p_user_id, 'adjustment', p_delta, v_balance, 'admin_adjustment', v_reference_id,
    'Admin adjustment: ' || trim(p_reason) || ' (admin ' || COALESCE(p_admin_telegram_id::TEXT, 'unknown') || ')'
  )
  RETURNING id, wallet_transactions.created_at INTO v_transaction_id, v_created_at;

  RETURN QUERY SELECT v_transaction_id, p_user_id, p_delta, v_balance, v_created_at;
END;
$$;
REVOKE ALL ON FUNCTION admin_adjust_wallet(BIGINT,NUMERIC,TEXT,BIGINT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_adjust_wallet(BIGINT,NUMERIC,TEXT,BIGINT,UUID) TO service_role;

-- Telegram Store Bot v6: screenshot-inspired UI, BEP20 and Order-ID-only Binance verification.
-- Safe for the current production database: no user, product, order, wallet or history rows are removed.

BEGIN;

ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_payment_method_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_payment_method_check
  CHECK (payment_method IN ('binance', 'usdt_bep20', 'usdt_trc20'));

INSERT INTO payment_settings(method_key, display_name, enabled, public_config)
VALUES (
  'usdt_bep20', 'USDT (BEP20)', TRUE,
  '{"network_name":"BNB Smart Chain (BEP20)","minimum":"1","maximum":"50","presets":[5,10,25,50],"expiration_minutes":30,"address":"","instructions":"Add any withdrawal fee on top so the full requested amount arrives."}'::JSONB
)
ON CONFLICT (method_key) DO UPDATE SET
  display_name = CASE WHEN payment_settings.display_name ILIKE '%TRC20%' THEN EXCLUDED.display_name ELSE payment_settings.display_name END,
  updated_at = NOW();

UPDATE payment_settings SET enabled = FALSE, updated_at = NOW()
WHERE method_key = 'usdt_trc20';

INSERT INTO bot_settings(key, value, description, is_public) VALUES
  ('menu_layout','two','Main menu layout: one, two or auto',TRUE),
  ('menu_products_enabled','true','Show Products in Telegram main menu',TRUE),
  ('menu_wallet_enabled','true','Show Wallet in Telegram main menu',TRUE),
  ('menu_deposit_enabled','true','Show Deposit in Telegram main menu',TRUE),
  ('menu_orders_enabled','true','Show My Orders in Telegram main menu',TRUE),
  ('menu_support_enabled','true','Show Support in Telegram main menu',TRUE),
  ('menu_about_enabled','true','Show About in Telegram main menu',TRUE),
  ('menu_channel_enabled','true','Show Channel in Telegram main menu',TRUE),
  ('menu_more_enabled','true','Show More in Telegram main menu',TRUE),
  ('products_label_en','🛍 Products','Products button label (English)',TRUE),
  ('products_label_ar','🛍 المنتجات','Products button label (Arabic)',TRUE),
  ('products_label_hi','🛍 उत्पाद','Products button label (Hindi)',TRUE),
  ('wallet_label_en','💰 Wallet','Wallet button label (English)',TRUE),
  ('wallet_label_ar','💰 المحفظة','Wallet button label (Arabic)',TRUE),
  ('wallet_label_hi','💰 वॉलेट','Wallet button label (Hindi)',TRUE),
  ('deposit_label_en','➕ Deposit','Deposit button label (English)',TRUE),
  ('deposit_label_ar','➕ إيداع','Deposit button label (Arabic)',TRUE),
  ('deposit_label_hi','➕ जमा','Deposit button label (Hindi)',TRUE),
  ('orders_label_en','📦 My Orders','Orders button label (English)',TRUE),
  ('orders_label_ar','📦 طلباتي','Orders button label (Arabic)',TRUE),
  ('orders_label_hi','📦 मेरे ऑर्डर','Orders button label (Hindi)',TRUE),
  ('support_label_en','💬 Support','Support button label (English)',TRUE),
  ('support_label_ar','💬 الدعم','Support button label (Arabic)',TRUE),
  ('support_label_hi','💬 सहायता','Support button label (Hindi)',TRUE),
  ('about_label_en','ℹ️ About','About button label (English)',TRUE),
  ('about_label_ar','ℹ️ حول المتجر','About button label (Arabic)',TRUE),
  ('about_label_hi','ℹ️ हमारे बारे में','About button label (Hindi)',TRUE),
  ('channel_label_en','📢 Join Channel','Channel button label (English)',TRUE),
  ('channel_label_ar','📢 انضم للقناة','Channel button label (Arabic)',TRUE),
  ('channel_label_hi','📢 चैनल से जुड़ें','Channel button label (Hindi)',TRUE),
  ('quantity_mode','auto','Quantity keyboard mode',TRUE),
  ('quantity_sequential_threshold','20','Show every number up to this stock',TRUE),
  ('quantity_presets','1,2,3,5,10,20','Quantity presets for large stock',TRUE),
  ('quantity_custom_enabled','true','Allow custom quantity',TRUE),
  ('quantity_buttons_per_row','3','Quantity reply-keyboard columns',TRUE),
  ('product_custom_emoji_id','','Telegram custom emoji ID for products',TRUE),
  ('price_custom_emoji_id','','Telegram custom emoji ID for prices',TRUE),
  ('stock_custom_emoji_id','','Telegram custom emoji ID for stock',TRUE),
  ('sold_custom_emoji_id','','Telegram custom emoji ID for sold count',TRUE),
  ('warranty_custom_emoji_id','','Telegram custom emoji ID for warranty',TRUE),
  ('binance_custom_emoji_id','','Telegram custom emoji ID for Binance',TRUE),
  ('success_custom_emoji_id','','Telegram custom emoji ID for success messages',TRUE),
  ('custom_emojis_enabled','true','Enable validated Telegram Custom Emojis with Unicode fallback',TRUE),
  ('chat_cleanup_enabled','true','Keep the newest user message and clean transient bot messages',TRUE)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION create_deposit(
  p_telegram_id BIGINT,
  p_method TEXT,
  p_requested_amount NUMERIC,
  p_expiry_minutes INTEGER,
  p_payment_address TEXT DEFAULT NULL
) RETURNS TABLE(
  id UUID, deposit_code TEXT, requested_amount NUMERIC, expected_amount NUMERIC,
  currency TEXT, payment_method TEXT, payment_address TEXT, status TEXT, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_id UUID;
  v_code TEXT;
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_method NOT IN ('binance', 'usdt_bep20') THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
  IF p_requested_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_expiry_minutes < 1 OR p_expiry_minutes > 1440 THEN RAISE EXCEPTION 'INVALID_EXPIRY'; END IF;
  IF p_method = 'usdt_bep20' AND (p_payment_address IS NULL OR p_payment_address !~ '^0x[0-9A-Fa-f]{40}$') THEN
    RAISE EXCEPTION 'INVALID_BEP20_ADDRESS';
  END IF;

  SELECT * INTO v_user FROM users WHERE telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  v_id := gen_random_uuid();
  v_code := 'D' || substring(replace(v_id::TEXT, '-', '') FROM 1 FOR 24);
  v_expires := NOW() + make_interval(mins => p_expiry_minutes);
  RETURN QUERY
  INSERT INTO deposits(
    id, deposit_code, user_id, requested_amount, expected_amount, currency, network,
    payment_method, payment_address, expires_at
  ) VALUES (
    v_id, v_code, v_user.id, p_requested_amount, p_requested_amount, 'USDT',
    CASE WHEN p_method = 'usdt_bep20' THEN 'BEP20' ELSE NULL END,
    p_method, p_payment_address, v_expires
  ) RETURNING deposits.id, deposits.deposit_code::TEXT, deposits.requested_amount,
    deposits.expected_amount, deposits.currency::TEXT, deposits.payment_method::TEXT,
    deposits.payment_address, deposits.status::TEXT, deposits.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION submit_usdt_txid(
  p_telegram_id BIGINT,
  p_deposit_id UUID,
  p_transaction_id TEXT
) RETURNS TABLE(
  id UUID, deposit_code TEXT, telegram_id BIGINT, username TEXT,
  requested_amount NUMERIC, expected_amount NUMERIC, payment_address TEXT,
  transaction_id TEXT, status TEXT, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE; v_txid TEXT;
BEGIN
  v_txid := lower(btrim(p_transaction_id));
  SELECT d.* INTO v_deposit
  FROM deposits d JOIN users u ON u.id = d.user_id
  WHERE d.id = p_deposit_id AND u.telegram_id = p_telegram_id FOR UPDATE OF d;
  IF NOT FOUND OR v_deposit.payment_method NOT IN ('usdt_bep20', 'usdt_trc20') THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  IF v_deposit.payment_method = 'usdt_bep20' AND v_txid !~ '^0x[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_TXID'; END IF;
  IF v_deposit.payment_method = 'usdt_trc20' AND v_txid !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_TXID'; END IF;
  IF EXISTS (SELECT 1 FROM deposits d WHERE lower(d.transaction_id) = v_txid AND d.id <> p_deposit_id) THEN
    RAISE EXCEPTION 'DUPLICATE_TXID';
  END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id;
  IF v_deposit.expires_at <= NOW() THEN
    UPDATE deposits SET status = 'expired', reservation_active = FALSE, updated_at = NOW() WHERE deposits.id = p_deposit_id;
    RETURN QUERY SELECT v_deposit.id, v_deposit.deposit_code::TEXT, v_user.telegram_id, v_user.username,
      v_deposit.requested_amount, v_deposit.expected_amount, v_deposit.payment_address,
      v_deposit.transaction_id, 'expired'::TEXT, v_deposit.created_at, v_deposit.expires_at;
    RETURN;
  END IF;
  IF v_deposit.status <> 'pending' OR v_deposit.transaction_id IS NOT NULL THEN RAISE EXCEPTION 'DEPOSIT_NOT_PENDING'; END IF;
  UPDATE deposits SET transaction_id = v_txid, status = 'pending_review', updated_at = NOW()
  WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_deposit.deposit_code::TEXT, v_user.telegram_id, v_user.username,
    v_deposit.requested_amount, v_deposit.expected_amount, v_deposit.payment_address,
    v_txid, 'pending_review'::TEXT, v_deposit.created_at, v_deposit.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION approve_manual_deposit(p_deposit_id UUID, p_admin_telegram_id BIGINT)
RETURNS TABLE(id UUID, telegram_id BIGINT, amount NUMERIC, status TEXT, credited BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE; v_balance NUMERIC(20,8);
BEGIN
  SELECT * INTO v_deposit FROM deposits WHERE deposits.id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id FOR UPDATE;
  IF v_deposit.status = 'approved' THEN
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.expires_at <= NOW() THEN
    UPDATE deposits SET status = 'expired', reservation_active = FALSE, reviewed_at = NOW(),
      approved_by = p_admin_telegram_id, updated_at = NOW() WHERE deposits.id = p_deposit_id;
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'expired'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.payment_method NOT IN ('usdt_bep20', 'usdt_trc20') OR v_deposit.status <> 'pending_review' OR v_deposit.transaction_id IS NULL THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_REVIEWABLE';
  END IF;
  UPDATE users SET wallet_balance = wallet_balance + v_deposit.expected_amount, updated_at = NOW()
    WHERE users.id = v_user.id RETURNING wallet_balance INTO v_balance;
  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', v_deposit.expected_amount, v_balance, 'deposit', v_deposit.id::TEXT,
    CASE WHEN v_deposit.payment_method = 'usdt_bep20' THEN 'USDT BEP20 deposit' ELSE 'Legacy USDT TRC20 deposit' END);
  UPDATE deposits SET status = 'approved', reservation_active = FALSE, paid_at = NOW(), approved_at = NOW(),
    reviewed_at = NOW(), approved_by = p_admin_telegram_id, updated_at = NOW() WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION approve_binance_history_deposit(
  p_deposit_id UUID,
  p_provider_transaction_id TEXT,
  p_received_amount NUMERIC,
  p_currency TEXT,
  p_paid_at TIMESTAMPTZ
) RETURNS TABLE(
  id UUID, telegram_id BIGINT, expected_amount NUMERIC, amount NUMERIC,
  currency TEXT, status TEXT, credited BOOLEAN, amount_matches BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deposit deposits%ROWTYPE;
  v_user users%ROWTYPE;
  v_balance NUMERIC(20,8);
  v_order_id TEXT;
BEGIN
  v_order_id := btrim(p_provider_transaction_id); -- compatibility name; this value is strictly Binance orderId
  IF v_order_id !~ '^[0-9]{8,32}$' THEN RAISE EXCEPTION 'BINANCE_ORDER_ID_INVALID'; END IF;
  IF p_received_amount IS NULL OR p_received_amount <= 0 THEN RAISE EXCEPTION 'BINANCE_AMOUNT_INVALID'; END IF;

  SELECT * INTO v_deposit FROM deposits WHERE deposits.id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id FOR UPDATE;
  IF v_deposit.status = 'approved' THEN
    IF v_deposit.provider_order_id = v_order_id THEN
      RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount,
        COALESCE(v_deposit.received_amount, v_deposit.expected_amount), v_deposit.currency::TEXT,
        'approved'::TEXT, FALSE,
        COALESCE(v_deposit.received_amount, v_deposit.expected_amount) = v_deposit.expected_amount;
      RETURN;
    END IF;
    RAISE EXCEPTION 'DEPOSIT_NOT_PENDING';
  END IF;
  IF v_deposit.payment_method <> 'binance' OR v_deposit.status NOT IN ('pending', 'expired') THEN RAISE EXCEPTION 'DEPOSIT_NOT_PENDING'; END IF;
  IF upper(v_deposit.currency) <> upper(p_currency) THEN RAISE EXCEPTION 'BINANCE_CURRENCY_MISMATCH'; END IF;
  IF p_paid_at > v_deposit.expires_at THEN RAISE EXCEPTION 'BINANCE_PAYMENT_EXPIRED'; END IF;
  IF p_paid_at < v_deposit.created_at - INTERVAL '2 minutes' THEN RAISE EXCEPTION 'BINANCE_PAYMENT_TOO_EARLY'; END IF;
  IF EXISTS (SELECT 1 FROM deposits d WHERE d.id <> v_deposit.id AND d.provider_order_id = v_order_id) THEN
    RAISE EXCEPTION 'DUPLICATE_BINANCE_ORDER_ID';
  END IF;

  UPDATE users SET wallet_balance = wallet_balance + p_received_amount, updated_at = NOW()
  WHERE users.id = v_user.id RETURNING wallet_balance INTO v_balance;
  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', p_received_amount, v_balance, 'deposit', v_deposit.id::TEXT, 'Binance Pay Order ID deposit');
  UPDATE deposits SET status = 'approved', reservation_active = FALSE,
    received_amount = p_received_amount, transaction_id = v_order_id, provider_order_id = v_order_id,
    provider_transaction_id = NULL, paid_at = p_paid_at, approved_at = NOW(), updated_at = NOW()
  WHERE deposits.id = v_deposit.id;
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount,
    p_received_amount, v_deposit.currency::TEXT, 'approved'::TEXT, TRUE,
    p_received_amount = v_deposit.expected_amount;
END;
$$;

CREATE TABLE IF NOT EXISTS scheduled_sales (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  normal_price NUMERIC(20,8) NOT NULL CHECK (normal_price >= 0),
  sale_price NUMERIC(20,8) NOT NULL CHECK (sale_price >= 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','completed','cancelled','failed')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (sale_price < normal_price)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_sales_due ON scheduled_sales(status, starts_at, ends_at);
ALTER TABLE scheduled_sales ENABLE ROW LEVEL SECURITY;
GRANT ALL ON scheduled_sales TO service_role;
GRANT USAGE, SELECT ON SEQUENCE scheduled_sales_id_seq TO service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'scheduled_sales'
    ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE scheduled_sales;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

REVOKE ALL ON FUNCTION create_deposit(BIGINT,TEXT,NUMERIC,INTEGER,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_usdt_txid(BIGINT,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_manual_deposit(UUID,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_binance_history_deposit(UUID,TEXT,NUMERIC,TEXT,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_deposit(BIGINT,TEXT,NUMERIC,INTEGER,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION submit_usdt_txid(BIGINT,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_manual_deposit(UUID,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_binance_history_deposit(UUID,TEXT,NUMERIC,TEXT,TIMESTAMPTZ) TO service_role;

COMMIT;

-- Telegram Store Bot v6.3
-- Adds: percentage-based customer referrals, merchant referral links,
-- Solana (SOL) manual deposits, and admin-controlled mandatory channel join.
-- Additive and idempotent: no business table or existing row is removed,
-- and every new feature defaults to its safe "off" state.
--
-- Safe to run multiple times and safe on the current v6.2 production database.
-- Back up the database before applying this file in production.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Users: referral identity, attribution and onboarding gate
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_type VARCHAR(20);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_referred_by_type_check;
ALTER TABLE users ADD CONSTRAINT users_referred_by_type_check
  CHECK (referred_by_type IS NULL OR referred_by_type IN ('user', 'merchant'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS attributed_at TIMESTAMPTZ;
-- Existing installations: every current row defaults to TRUE so no existing
-- user is ever routed back through language selection or a force-join gate.
-- ensure_bot_user() below explicitly sets FALSE only for brand-new inserts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_user_id) WHERE referred_by_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Merchant referral links (admin-managed, independent of user referrals)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS merchant_referral_links (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  label TEXT NOT NULL DEFAULT '',
  commission_percent NUMERIC(6,3) NOT NULL CHECK (commission_percent > 0 AND commission_percent <= 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);
CREATE INDEX IF NOT EXISTS idx_merchant_links_owner ON merchant_referral_links(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_links_active ON merchant_referral_links(active, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_merchant_link_id BIGINT REFERENCES merchant_referral_links(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_referred_by_merchant ON users(referred_by_merchant_link_id) WHERE referred_by_merchant_link_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Referral commissions ledger (one row per order at most; source of truth
--    for reversal safety independent of wallet_transactions bookkeeping)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS referral_commissions (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  beneficiary_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  referred_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('user_referral', 'merchant_referral')),
  source_id BIGINT REFERENCES merchant_referral_links(id) ON DELETE SET NULL,
  commission_percent NUMERIC(6,3) NOT NULL CHECK (commission_percent > 0),
  order_amount NUMERIC(20,8) NOT NULL CHECK (order_amount >= 0),
  commission_amount NUMERIC(20,8) NOT NULL CHECK (commission_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'credited' CHECK (status IN ('credited', 'reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_beneficiary ON referral_commissions(beneficiary_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_source ON referral_commissions(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_created ON referral_commissions(created_at DESC);

-- ---------------------------------------------------------------------------
-- 4) Required (mandatory-join) channels
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS required_channels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  chat_ref TEXT NOT NULL, -- Telegram chat id or @username the bot checks membership against
  join_url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by BIGINT
);
CREATE INDEX IF NOT EXISTS idx_required_channels_active_sort ON required_channels(active, sort_order, id);

-- Tracks whether a not-yet-onboarded user has already picked a language, so
-- the mandatory-join screen (if any) is not re-preceded by language
-- selection on every retry while access is still pending.
ALTER TABLE user_ui_state ADD COLUMN IF NOT EXISTS onboarding_language_chosen BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- 5) Wallet transaction types + deposit payment methods: widen safely
-- ---------------------------------------------------------------------------

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN ('deposit', 'purchase', 'refund', 'adjustment', 'referral_commission', 'referral_commission_reversal'));

ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_payment_method_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_payment_method_check
  CHECK (payment_method IN ('binance', 'usdt_bep20', 'usdt_trc20', 'solana'));

-- ---------------------------------------------------------------------------
-- 6) Default settings: everything new starts OFF / safe
-- ---------------------------------------------------------------------------

INSERT INTO bot_settings(key, value, description, is_public) VALUES
  ('referral_enabled', 'false', 'Enable the customer Referrals feature and its main menu button', TRUE),
  ('referral_commission_percent', '10', 'Percentage commission credited to a referrer on each referred purchase', TRUE),
  ('menu_referrals_enabled', 'false', 'Show Referrals in the Telegram main menu (mirrors referral_enabled)', TRUE),
  ('referrals_label_en', '🎁 Referrals', 'Referrals button label (English)', TRUE),
  ('referrals_label_ar', '🎁 الإحالات', 'Referrals button label (Arabic)', TRUE),
  ('referrals_label_hi', '🎁 रेफ़रल', 'Referrals button label (Hindi)', TRUE),
  ('force_join_enabled', 'false', 'Require users to join all active Required Channels before using the bot', TRUE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO payment_settings(method_key, display_name, enabled, public_config) VALUES (
  'solana', 'SOL (Solana)', TRUE,
  '{"network_name":"Solana","minimum":"1","maximum":"50","presets":[1,2,5],"expiration_minutes":30,"address":"","instructions":"Send exactly the requested amount, then submit the transaction signature."}'::JSONB
)
ON CONFLICT (method_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7) ensure_bot_user(): capture referral attribution for brand-new users only
--    and gate onboarding_completed for the language/force-join flow.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_bot_user(
  p_telegram_id BIGINT,
  p_username TEXT,
  p_first_name TEXT,
  p_default_language TEXT DEFAULT 'en',
  p_last_name TEXT DEFAULT NULL,
  p_referral_payload TEXT DEFAULT NULL
) RETURNS SETOF users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_was_new BOOLEAN;
  v_user_id BIGINT;
  v_ref_code TEXT;
  v_referrer_id BIGINT;
  v_link merchant_referral_links%ROWTYPE;
BEGIN
  IF p_default_language NOT IN ('en', 'ar', 'hi') THEN p_default_language := 'en'; END IF;

  SELECT NOT EXISTS(SELECT 1 FROM users WHERE telegram_id = p_telegram_id) INTO v_was_new;

  INSERT INTO users(telegram_id, username, first_name, last_name, language, onboarding_completed)
  VALUES (p_telegram_id, p_username, p_first_name, p_last_name, p_default_language, FALSE)
  ON CONFLICT (telegram_id) DO UPDATE SET
    username = EXCLUDED.username,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    updated_at = NOW()
  RETURNING id INTO v_user_id;

  -- Attribution only ever happens at true first contact. A returning user
  -- opening a different referral link can never change or gain a referrer.
  IF v_was_new AND p_referral_payload IS NOT NULL AND p_referral_payload <> '' THEN
    IF p_referral_payload ~ '^ref_[A-Za-z0-9]{4,16}$' THEN
      v_ref_code := substring(p_referral_payload FROM 5);
      SELECT id INTO v_referrer_id FROM users WHERE referral_code = v_ref_code;
      IF FOUND AND v_referrer_id <> v_user_id THEN
        UPDATE users SET referred_by_user_id = v_referrer_id, referred_by_type = 'user',
          referred_by_merchant_link_id = NULL, attributed_at = NOW()
        WHERE id = v_user_id AND referred_by_user_id IS NULL;
      END IF;
    ELSIF p_referral_payload ~ '^merchant_[A-Za-z0-9]{4,32}$' THEN
      SELECT * INTO v_link FROM merchant_referral_links
      WHERE code = substring(p_referral_payload FROM 10) AND active;
      IF FOUND AND v_link.owner_user_id <> v_user_id THEN
        UPDATE users SET referred_by_user_id = v_link.owner_user_id, referred_by_type = 'merchant',
          referred_by_merchant_link_id = v_link.id, attributed_at = NOW()
        WHERE id = v_user_id AND referred_by_user_id IS NULL;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM users WHERE id = v_user_id;
END;
$$;
REVOKE ALL ON FUNCTION ensure_bot_user(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_bot_user(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 8) Referral code + onboarding completion helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_or_create_referral_code(p_user_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code TEXT;
  v_charset TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I ambiguity
  v_attempt INTEGER;
  v_char_index INTEGER;
BEGIN
  SELECT referral_code INTO v_code FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_code IS NOT NULL THEN RETURN v_code; END IF;

  FOR v_attempt IN 1..30 LOOP
    v_code := '';
    FOR v_char_index IN 1..8 LOOP
      v_code := v_code || substr(v_charset, floor(random() * length(v_charset))::INT + 1, 1);
    END LOOP;
    BEGIN
      UPDATE users SET referral_code = v_code WHERE id = p_user_id;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt = 30 THEN RAISE EXCEPTION 'REFERRAL_CODE_GENERATION_FAILED'; END IF;
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION get_or_create_referral_code(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_or_create_referral_code(BIGINT) TO service_role;

CREATE OR REPLACE FUNCTION complete_onboarding(p_telegram_id BIGINT, p_language TEXT)
RETURNS SETOF users LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_language NOT IN ('en', 'ar', 'hi') THEN p_language := 'en'; END IF;
  RETURN QUERY UPDATE users SET language = p_language, onboarding_completed = TRUE, updated_at = NOW()
    WHERE telegram_id = p_telegram_id RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION complete_onboarding(BIGINT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_onboarding(BIGINT,TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 9) Referral commission application (called from inside purchase_product_v2,
--    same transaction => truly atomic with the wallet debit that funds it).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_order_referral_commission(
  p_order_id BIGINT, p_buyer_user_id BIGINT, p_order_total NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_buyer users%ROWTYPE;
  v_beneficiary_id BIGINT;
  v_source_type TEXT;
  v_source_id BIGINT;
  v_percent NUMERIC(6,3);
  v_link merchant_referral_links%ROWTYPE;
  v_commission NUMERIC(20,8);
  v_commission_id BIGINT;
  v_balance NUMERIC(20,8);
  v_referral_enabled TEXT;
BEGIN
  IF p_order_total IS NULL OR p_order_total <= 0 THEN RETURN; END IF;

  SELECT * INTO v_buyer FROM users WHERE id = p_buyer_user_id;
  IF NOT FOUND OR v_buyer.referred_by_user_id IS NULL OR v_buyer.referred_by_type IS NULL THEN RETURN; END IF;
  IF v_buyer.referred_by_user_id = p_buyer_user_id THEN RETURN; END IF; -- defensive; attribution never allows this

  IF v_buyer.referred_by_type = 'user' THEN
    SELECT value INTO v_referral_enabled FROM bot_settings WHERE key = 'referral_enabled';
    IF COALESCE(lower(v_referral_enabled), 'false') <> 'true' THEN RETURN; END IF;
    v_beneficiary_id := v_buyer.referred_by_user_id;
    v_source_type := 'user_referral';
    v_source_id := NULL;
    SELECT COALESCE(NULLIF(value, '')::NUMERIC, 10) INTO v_percent FROM bot_settings WHERE key = 'referral_commission_percent';
    v_percent := COALESCE(v_percent, 10);
  ELSIF v_buyer.referred_by_type = 'merchant' THEN
    IF v_buyer.referred_by_merchant_link_id IS NULL THEN RETURN; END IF;
    SELECT * INTO v_link FROM merchant_referral_links WHERE id = v_buyer.referred_by_merchant_link_id;
    IF NOT FOUND OR NOT v_link.active THEN RETURN; END IF;
    v_beneficiary_id := v_link.owner_user_id;
    v_source_type := 'merchant_referral';
    v_source_id := v_link.id;
    v_percent := v_link.commission_percent;
  ELSE
    RETURN;
  END IF;

  IF v_beneficiary_id IS NULL OR v_beneficiary_id = p_buyer_user_id OR v_percent IS NULL OR v_percent <= 0 THEN RETURN; END IF;

  v_commission := round(p_order_total * v_percent / 100, 8);
  IF v_commission <= 0 THEN RETURN; END IF;

  -- order_id is UNIQUE: this insert is the idempotency guard against retries,
  -- duplicate callbacks, and double-processing of the same order.
  INSERT INTO referral_commissions(
    order_id, beneficiary_user_id, referred_user_id, source_type, source_id,
    commission_percent, order_amount, commission_amount, status
  ) VALUES (
    p_order_id, v_beneficiary_id, p_buyer_user_id, v_source_type, v_source_id,
    v_percent, p_order_total, v_commission, 'credited'
  )
  ON CONFLICT (order_id) DO NOTHING
  RETURNING id INTO v_commission_id;

  IF v_commission_id IS NULL THEN RETURN; END IF; -- already processed

  UPDATE users SET wallet_balance = wallet_balance + v_commission, updated_at = NOW()
  WHERE id = v_beneficiary_id RETURNING wallet_balance INTO v_balance;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (
    v_beneficiary_id, 'referral_commission', v_commission, v_balance, 'referral_commission', p_order_id::TEXT,
    CASE WHEN v_source_type = 'merchant_referral' THEN 'Merchant referral commission for order #' || p_order_id
      ELSE 'Referral commission for order #' || p_order_id END
  );
END;
$$;
REVOKE ALL ON FUNCTION apply_order_referral_commission(BIGINT,BIGINT,NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_order_referral_commission(BIGINT,BIGINT,NUMERIC) TO service_role;

-- ---------------------------------------------------------------------------
-- 10) purchase_product_v2(): unchanged behavior, plus one atomic call to
--     apply_order_referral_commission() right after the purchase debit, in
--     the exact same database transaction. No new client-visible fields.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION purchase_product_v2(
  p_telegram_id BIGINT,
  p_product_id BIGINT,
  p_quantity INTEGER,
  p_idempotency_key TEXT
) RETURNS TABLE(
  order_id BIGINT, product_name TEXT, quantity INTEGER, unit_price NUMERIC,
  total_amount NUMERIC, status TEXT, fulfillment_type TEXT,
  delivery_time TEXT, warranty_value INTEGER, warranty_unit TEXT,
  public_instructions TEXT, payload_ciphertexts TEXT[], payload_ivs TEXT[],
  payload_auth_tags TEXT[], already_processed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_product products%ROWTYPE;
  v_order orders%ROWTYPE;
  v_unit_price NUMERIC(20,8);
  v_total NUMERIC(20,8);
  v_balance NUMERIC(20,8);
  v_item_ids BIGINT[];
  v_item_count INTEGER;
  v_updated_count INTEGER;
  v_ciphertexts TEXT[];
  v_ivs TEXT[];
  v_tags TEXT[];
  v_order_owner BIGINT;
BEGIN
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 1000 THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  SELECT o.* INTO v_order FROM orders o WHERE o.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT u.telegram_id INTO v_order_owner FROM users u WHERE u.id = v_order.user_id;
    IF v_order_owner <> p_telegram_id OR v_order.product_id <> p_product_id OR v_order.quantity <> p_quantity THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    SELECT array_agg(i.payload_ciphertext ORDER BY i.id), array_agg(i.payload_iv ORDER BY i.id),
      array_agg(i.payload_auth_tag ORDER BY i.id)
    INTO v_ciphertexts, v_ivs, v_tags FROM product_inventory_items i WHERE i.order_id = v_order.id AND i.status = 'sold';
    IF v_order.fulfillment_type = 'instant' AND v_order.status = 'delivered' AND
       (cardinality(COALESCE(v_ciphertexts, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_ivs, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_tags, ARRAY[]::TEXT[])) <> v_order.quantity) THEN
      RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH';
    END IF;
    RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.quantity, v_order.unit_price,
      v_order.total_amount, v_order.status::TEXT, v_order.fulfillment_type::TEXT,
      v_order.delivery_time_snapshot, v_order.warranty_value_snapshot, v_order.warranty_unit_snapshot,
      v_order.public_instructions_snapshot, COALESCE(v_ciphertexts, ARRAY[]::TEXT[]),
      COALESCE(v_ivs, ARRAY[]::TEXT[]), COALESCE(v_tags, ARRAY[]::TEXT[]), TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_user FROM users u WHERE u.telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  SELECT * INTO v_order FROM orders o WHERE o.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_order.user_id <> v_user.id OR v_order.product_id <> p_product_id OR v_order.quantity <> p_quantity THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    SELECT array_agg(i.payload_ciphertext ORDER BY i.id), array_agg(i.payload_iv ORDER BY i.id),
      array_agg(i.payload_auth_tag ORDER BY i.id)
    INTO v_ciphertexts, v_ivs, v_tags FROM product_inventory_items i WHERE i.order_id = v_order.id AND i.status = 'sold';
    IF v_order.fulfillment_type = 'instant' AND v_order.status = 'delivered' AND
       (cardinality(COALESCE(v_ciphertexts, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_ivs, ARRAY[]::TEXT[])) <> v_order.quantity OR
        cardinality(COALESCE(v_tags, ARRAY[]::TEXT[])) <> v_order.quantity) THEN
      RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH';
    END IF;
    RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.quantity, v_order.unit_price,
      v_order.total_amount, v_order.status::TEXT, v_order.fulfillment_type::TEXT,
      v_order.delivery_time_snapshot, v_order.warranty_value_snapshot, v_order.warranty_unit_snapshot,
      v_order.public_instructions_snapshot, COALESCE(v_ciphertexts, ARRAY[]::TEXT[]),
      COALESCE(v_ivs, ARRAY[]::TEXT[]), COALESCE(v_tags, ARRAY[]::TEXT[]), TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_product FROM products p WHERE p.id = p_product_id FOR UPDATE;
  IF NOT FOUND OR NOT v_product.active THEN RAISE EXCEPTION 'PRODUCT_UNAVAILABLE'; END IF;
  IF p_quantity < v_product.min_quantity OR p_quantity > v_product.max_quantity THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;

  v_unit_price := v_product.price;
  IF v_product.bulk_pricing_enabled THEN
    SELECT t.unit_price INTO v_unit_price FROM bulk_pricing_tiers t
    WHERE t.product_id = v_product.id AND t.min_quantity <= p_quantity
      AND (t.max_quantity IS NULL OR t.max_quantity >= p_quantity)
    ORDER BY t.min_quantity DESC LIMIT 1;
    v_unit_price := COALESCE(v_unit_price, v_product.price);
  END IF;
  v_total := v_unit_price * p_quantity;
  IF v_user.wallet_balance < v_total THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;

  IF v_product.fulfillment_type = 'instant' THEN
    SELECT array_agg(s.id ORDER BY s.id), count(*)::INTEGER INTO v_item_ids, v_item_count
    FROM (
      SELECT i.id FROM product_inventory_items i
      WHERE i.product_id = v_product.id AND i.status = 'available' AND i.order_id IS NULL
      ORDER BY i.id FOR UPDATE SKIP LOCKED LIMIT p_quantity
    ) s;
    IF COALESCE(v_item_count, 0) <> p_quantity THEN RAISE EXCEPTION 'OUT_OF_STOCK'; END IF;
  ELSE
    IF NOT v_product.unlimited_stock AND v_product.manual_stock < p_quantity AND NOT v_product.allow_preorder THEN
      RAISE EXCEPTION 'OUT_OF_STOCK';
    END IF;
    IF NOT v_product.unlimited_stock THEN
      UPDATE products SET manual_stock = GREATEST(manual_stock - p_quantity, 0),
        stock = GREATEST(stock - p_quantity, 0), updated_at = NOW()
      WHERE id = v_product.id;
    END IF;
  END IF;

  UPDATE users SET wallet_balance = wallet_balance - v_total, updated_at = NOW()
  WHERE id = v_user.id AND wallet_balance >= v_total RETURNING wallet_balance INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE'; END IF;

  INSERT INTO orders(
    user_id, product_id, product_name, amount, status, delivery_data, idempotency_key,
    quantity, unit_price, total_amount, fulfillment_type, delivery_time_snapshot,
    warranty_value_snapshot, warranty_unit_snapshot, public_instructions_snapshot,
    payment_method, delivered_at, delivery_snapshot
  ) VALUES (
    v_user.id, v_product.id, v_product.name, v_total,
    CASE WHEN v_product.fulfillment_type = 'instant' THEN 'delivered' ELSE 'processing' END,
    '', p_idempotency_key, p_quantity, v_unit_price, v_total, v_product.fulfillment_type,
    v_product.delivery_time_label, v_product.warranty_value, v_product.warranty_unit,
    v_product.public_instructions, 'wallet',
    CASE WHEN v_product.fulfillment_type = 'instant' THEN NOW() ELSE NULL END,
    jsonb_build_object(
      'product_name', v_product.name, 'subtitle', COALESCE(v_product.subtitle, ''),
      'duration', COALESCE(v_product.duration, ''), 'product_type', COALESCE(v_product.product_type, ''),
      'emoji', COALESCE(v_product.emoji, ''), 'short_description', COALESCE(v_product.short_description, ''),
      'full_description', COALESCE(v_product.full_description, COALESCE(v_product.description, '')),
      'public_instructions', COALESCE(v_product.public_instructions, ''),
      'delivery_time', COALESCE(v_product.delivery_time_label, ''),
      'warranty_value', v_product.warranty_value, 'warranty_unit', COALESCE(v_product.warranty_unit, '')
    )
  ) RETURNING * INTO v_order;

  IF v_product.fulfillment_type = 'instant' THEN
    UPDATE product_inventory_items SET status = 'sold', order_id = v_order.id,
      sold_at = NOW(), reserved_at = NULL, updated_at = NOW()
    WHERE product_inventory_items.id = ANY(v_item_ids) AND product_inventory_items.product_id = v_product.id AND product_inventory_items.status = 'available' AND product_inventory_items.order_id IS NULL;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> p_quantity THEN RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH'; END IF;
    SELECT array_agg(i.payload_ciphertext ORDER BY i.id), array_agg(i.payload_iv ORDER BY i.id),
      array_agg(i.payload_auth_tag ORDER BY i.id)
    INTO v_ciphertexts, v_ivs, v_tags FROM product_inventory_items i WHERE i.order_id = v_order.id AND i.status = 'sold';
    IF cardinality(COALESCE(v_ciphertexts, ARRAY[]::TEXT[])) <> p_quantity OR
       cardinality(COALESCE(v_ivs, ARRAY[]::TEXT[])) <> p_quantity OR
       cardinality(COALESCE(v_tags, ARRAY[]::TEXT[])) <> p_quantity THEN
      RAISE EXCEPTION 'DELIVERY_COUNT_MISMATCH';
    END IF;
  END IF;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'purchase', -v_total, v_balance, 'order', v_order.id::TEXT, v_product.name);

  -- Same transaction as the debit above: either both commit or both roll back.
  PERFORM apply_order_referral_commission(v_order.id, v_user.id, v_total);

  RETURN QUERY SELECT v_order.id, v_order.product_name, v_order.quantity, v_order.unit_price,
    v_order.total_amount, v_order.status::TEXT, v_order.fulfillment_type::TEXT,
    v_order.delivery_time_snapshot, v_order.warranty_value_snapshot, v_order.warranty_unit_snapshot,
    v_order.public_instructions_snapshot, COALESCE(v_ciphertexts, ARRAY[]::TEXT[]),
    COALESCE(v_ivs, ARRAY[]::TEXT[]), COALESCE(v_tags, ARRAY[]::TEXT[]), FALSE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 11) review_refund_request(): unchanged behavior, plus atomic reversal of
--     any referral commission tied to the refunded order. Guarded by
--     referral_commissions.status so a refund can never reverse twice.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION review_refund_request(
  p_request_id BIGINT,
  p_admin_telegram_id BIGINT,
  p_decision TEXT,
  p_admin_note TEXT DEFAULT NULL
) RETURNS TABLE(request_id BIGINT, order_id BIGINT, telegram_id BIGINT, amount NUMERIC, status TEXT, changed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request refund_requests%ROWTYPE;
  v_order orders%ROWTYPE;
  v_user users%ROWTYPE;
  v_balance NUMERIC(20,8);
  v_commission referral_commissions%ROWTYPE;
  v_beneficiary users%ROWTYPE;
  v_reverse_amount NUMERIC(20,8);
  v_new_balance NUMERIC(20,8);
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'INVALID_REFUND_DECISION'; END IF;
  SELECT * INTO v_request FROM refund_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  SELECT * INTO v_order FROM orders o WHERE o.id = v_request.order_id FOR UPDATE;
  SELECT * INTO v_user FROM users u WHERE u.id = v_request.user_id FOR UPDATE;
  IF v_request.status <> 'pending' THEN
    RETURN QUERY SELECT v_request.id, v_order.id, v_user.telegram_id, v_order.total_amount,
      v_request.status::TEXT, FALSE;
    RETURN;
  END IF;
  IF p_decision = 'approved' THEN
    IF v_order.status = 'refunded' THEN RAISE EXCEPTION 'ORDER_ALREADY_REFUNDED'; END IF;
    IF v_order.status NOT IN ('processing', 'delivered') THEN RAISE EXCEPTION 'REFUND_NOT_ELIGIBLE'; END IF;
    UPDATE users SET wallet_balance = wallet_balance + v_order.total_amount, updated_at = NOW()
      WHERE id = v_user.id RETURNING wallet_balance INTO v_balance;
    UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = v_order.id;
    INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
    VALUES (v_user.id, 'refund', v_order.total_amount, v_balance, 'refund', v_request.id::TEXT, 'Refund for order #' || v_order.id);

    SELECT * INTO v_commission FROM referral_commissions WHERE order_id = v_order.id AND status = 'credited' FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO v_beneficiary FROM users WHERE id = v_commission.beneficiary_user_id FOR UPDATE;
      -- Never push the beneficiary's wallet negative: reverse at most what remains.
      v_reverse_amount := LEAST(v_commission.commission_amount, v_beneficiary.wallet_balance);
      IF v_reverse_amount > 0 THEN
        UPDATE users SET wallet_balance = wallet_balance - v_reverse_amount, updated_at = NOW()
          WHERE id = v_beneficiary.id RETURNING wallet_balance INTO v_new_balance;
        INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
        VALUES (v_beneficiary.id, 'referral_commission_reversal', -v_reverse_amount, v_new_balance,
          'referral_commission_reversal', v_order.id::TEXT,
          'Referral commission reversed for refunded order #' || v_order.id);
      END IF;
      UPDATE referral_commissions SET status = 'reversed', reversed_at = NOW() WHERE id = v_commission.id;
    END IF;
  END IF;
  UPDATE refund_requests SET status = p_decision, reviewed_at = NOW(), reviewed_by = p_admin_telegram_id,
    admin_note = left(COALESCE(p_admin_note, ''), 2000) WHERE id = v_request.id;
  RETURN QUERY SELECT v_request.id, v_order.id, v_user.telegram_id, v_order.total_amount, p_decision, TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 12) Deposits / payments: widen create_deposit, submit_usdt_txid and
--     approve_manual_deposit to accept 'solana' as a manual-review method,
--     exactly like usdt_bep20, with Solana-shaped address/signature checks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_deposit(
  p_telegram_id BIGINT,
  p_method TEXT,
  p_requested_amount NUMERIC,
  p_expiry_minutes INTEGER,
  p_payment_address TEXT DEFAULT NULL,
  p_price_used NUMERIC DEFAULT NULL,
  p_crypto_amount NUMERIC DEFAULT NULL,
  p_price_source TEXT DEFAULT NULL,
  p_price_at TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
  id UUID, deposit_code TEXT, requested_amount NUMERIC, expected_amount NUMERIC,
  currency TEXT, payment_method TEXT, payment_address TEXT, status TEXT, expires_at TIMESTAMPTZ,
  crypto_amount NUMERIC, price_used NUMERIC, price_source TEXT, price_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user users%ROWTYPE;
  v_id UUID;
  v_code TEXT;
  v_expires TIMESTAMPTZ;
  v_currency TEXT;
  v_network TEXT;
BEGIN
  IF p_method NOT IN ('binance', 'usdt_bep20', 'solana') THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
  IF p_requested_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_expiry_minutes < 1 OR p_expiry_minutes > 1440 THEN RAISE EXCEPTION 'INVALID_EXPIRY'; END IF;
  IF p_method = 'solana' AND p_requested_amount < 1 THEN RAISE EXCEPTION 'SOLANA_MINIMUM_USDT'; END IF;
  IF p_method = 'usdt_bep20' AND (p_payment_address IS NULL OR p_payment_address !~ '^0x[0-9A-Fa-f]{40}$') THEN
    RAISE EXCEPTION 'INVALID_BEP20_ADDRESS';
  END IF;
  IF p_method = 'solana' AND (p_payment_address IS NULL OR p_payment_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN
    RAISE EXCEPTION 'INVALID_SOLANA_ADDRESS';
  END IF;
  IF p_method = 'solana' AND (p_price_used IS NULL OR p_price_used <= 0 OR p_crypto_amount IS NULL OR p_crypto_amount <= 0 OR p_price_source IS NULL OR p_price_at IS NULL) THEN
    RAISE EXCEPTION 'SOL_PRICE_REQUIRED';
  END IF;

  SELECT * INTO v_user FROM users WHERE telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  v_currency := 'USDT';
  v_network := CASE WHEN p_method = 'usdt_bep20' THEN 'BEP20' WHEN p_method = 'solana' THEN 'Solana' ELSE NULL END;
  v_id := gen_random_uuid();
  v_code := 'D' || substring(replace(v_id::TEXT, '-', '') FROM 1 FOR 24);
  v_expires := NOW() + make_interval(mins => p_expiry_minutes);
  RETURN QUERY
  INSERT INTO deposits(
    id, deposit_code, user_id, requested_amount, expected_amount, currency, network,
    payment_method, payment_address, expires_at, crypto_amount, price_used, price_source, price_at
  ) VALUES (
    v_id, v_code, v_user.id, p_requested_amount, p_requested_amount, v_currency, v_network,
    p_method, p_payment_address, v_expires,
    CASE WHEN p_method = 'solana' THEN p_crypto_amount ELSE NULL END,
    CASE WHEN p_method = 'solana' THEN p_price_used ELSE NULL END,
    CASE WHEN p_method = 'solana' THEN p_price_source ELSE NULL END,
    CASE WHEN p_method = 'solana' THEN p_price_at ELSE NULL END
  ) RETURNING deposits.id, deposits.deposit_code::TEXT, deposits.requested_amount,
    deposits.expected_amount, deposits.currency::TEXT, deposits.payment_method::TEXT,
    deposits.payment_address, deposits.status::TEXT, deposits.expires_at,
    deposits.crypto_amount, deposits.price_used, deposits.price_source, deposits.price_at;
END;
$$;

CREATE OR REPLACE FUNCTION submit_usdt_txid(
  p_telegram_id BIGINT,
  p_deposit_id UUID,
  p_transaction_id TEXT
) RETURNS TABLE(
  id UUID, deposit_code TEXT, telegram_id BIGINT, username TEXT,
  requested_amount NUMERIC, expected_amount NUMERIC, payment_address TEXT,
  transaction_id TEXT, status TEXT, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE; v_txid TEXT;
BEGIN
  v_txid := btrim(p_transaction_id);
  SELECT d.* INTO v_deposit
  FROM deposits d JOIN users u ON u.id = d.user_id
  WHERE d.id = p_deposit_id AND u.telegram_id = p_telegram_id FOR UPDATE OF d;
  IF NOT FOUND OR v_deposit.payment_method NOT IN ('usdt_bep20', 'usdt_trc20', 'solana') THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;

  IF v_deposit.payment_method = 'usdt_bep20' THEN
    v_txid := lower(v_txid);
    IF v_txid !~ '^0x[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_TXID'; END IF;
  ELSIF v_deposit.payment_method = 'usdt_trc20' THEN
    v_txid := lower(v_txid);
    IF v_txid !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_TXID'; END IF;
  ELSE -- solana: base58 transaction signature, case-sensitive
    IF v_txid !~ '^[1-9A-HJ-NP-Za-km-z]{64,100}$' THEN RAISE EXCEPTION 'INVALID_TXID'; END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM deposits d
    WHERE d.payment_method = v_deposit.payment_method
      AND (CASE WHEN v_deposit.payment_method = 'solana' THEN d.transaction_id ELSE lower(d.transaction_id) END) = v_txid
      AND d.id <> p_deposit_id
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_TXID';
  END IF;

  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id;
  IF v_deposit.expires_at <= NOW() THEN
    UPDATE deposits SET status = 'expired', reservation_active = FALSE, updated_at = NOW() WHERE deposits.id = p_deposit_id;
    RETURN QUERY SELECT v_deposit.id, v_deposit.deposit_code::TEXT, v_user.telegram_id, v_user.username,
      v_deposit.requested_amount, v_deposit.expected_amount, v_deposit.payment_address,
      v_deposit.transaction_id, 'expired'::TEXT, v_deposit.created_at, v_deposit.expires_at;
    RETURN;
  END IF;
  IF v_deposit.status <> 'pending' OR v_deposit.transaction_id IS NOT NULL THEN RAISE EXCEPTION 'DEPOSIT_NOT_PENDING'; END IF;
  UPDATE deposits SET transaction_id = v_txid, status = 'pending_review', updated_at = NOW()
  WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_deposit.deposit_code::TEXT, v_user.telegram_id, v_user.username,
    v_deposit.requested_amount, v_deposit.expected_amount, v_deposit.payment_address,
    v_txid, 'pending_review'::TEXT, v_deposit.created_at, v_deposit.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION approve_manual_deposit(p_deposit_id UUID, p_admin_telegram_id BIGINT)
RETURNS TABLE(id UUID, telegram_id BIGINT, amount NUMERIC, status TEXT, credited BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deposit deposits%ROWTYPE;
  v_user users%ROWTYPE;
  v_balance NUMERIC(20,8);
  v_credit_amount NUMERIC(20,8);
  v_description TEXT;
BEGIN
  SELECT * INTO v_deposit FROM deposits WHERE deposits.id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPOSIT_NOT_FOUND'; END IF;
  SELECT * INTO v_user FROM users WHERE users.id = v_deposit.user_id FOR UPDATE;
  IF v_deposit.status = 'approved' THEN
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id,
      CASE WHEN v_deposit.payment_method = 'solana' AND v_deposit.price_used IS NOT NULL THEN v_deposit.requested_amount ELSE v_deposit.expected_amount END,
      'approved'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.expires_at <= NOW() THEN
    UPDATE deposits SET status = 'expired', reservation_active = FALSE, reviewed_at = NOW(), approved_by = p_admin_telegram_id, updated_at = NOW() WHERE deposits.id = p_deposit_id;
    RETURN QUERY SELECT v_deposit.id, v_user.telegram_id,
      CASE WHEN v_deposit.payment_method = 'solana' AND v_deposit.price_used IS NOT NULL THEN v_deposit.requested_amount ELSE v_deposit.expected_amount END,
      'expired'::TEXT, FALSE;
    RETURN;
  END IF;
  IF v_deposit.payment_method NOT IN ('usdt_bep20', 'usdt_trc20', 'solana') OR v_deposit.status <> 'pending_review' OR v_deposit.transaction_id IS NULL THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_REVIEWABLE';
  END IF;
  v_credit_amount := CASE WHEN v_deposit.payment_method = 'solana' AND v_deposit.price_used IS NOT NULL THEN v_deposit.requested_amount ELSE v_deposit.expected_amount END;
  UPDATE deposits SET status = 'approved', reservation_active = FALSE, reviewed_at = NOW(), approved_at = NOW(), approved_by = p_admin_telegram_id, paid_at = NOW(), updated_at = NOW() WHERE deposits.id = p_deposit_id;
  v_balance := v_user.wallet_balance + v_credit_amount;
  UPDATE users SET wallet_balance = v_balance, updated_at = NOW() WHERE id = v_user.id;
  v_description := CASE WHEN v_deposit.payment_method = 'solana' AND v_deposit.price_used IS NOT NULL THEN 'Solana deposit credited as USDT' WHEN v_deposit.payment_method = 'solana' THEN 'Legacy Solana (SOL) deposit' ELSE 'USDT deposit' END;
  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', v_credit_amount, v_balance, 'deposit', v_deposit.id::TEXT, v_description);
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_credit_amount, 'approved'::TEXT, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_bot_user(
  p_telegram_id BIGINT,
  p_username TEXT,
  p_first_name TEXT,
  p_default_language TEXT DEFAULT 'en',
  p_last_name TEXT DEFAULT NULL,
  p_referral_payload TEXT DEFAULT NULL
) RETURNS SETOF users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_was_new BOOLEAN;
  v_user_id BIGINT;
  v_ref_code TEXT;
  v_referrer_id BIGINT;
  v_link merchant_referral_links%ROWTYPE;
BEGIN
  IF p_default_language NOT IN ('en', 'ar', 'hi') THEN p_default_language := 'en'; END IF;

  SELECT NOT EXISTS(SELECT 1 FROM users WHERE telegram_id = p_telegram_id) INTO v_was_new;

  INSERT INTO users(telegram_id, username, first_name, last_name, language, onboarding_completed)
  VALUES (p_telegram_id, p_username, p_first_name, p_last_name, p_default_language, FALSE)
  ON CONFLICT (telegram_id) DO UPDATE SET
    username = EXCLUDED.username,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    updated_at = NOW()
  RETURNING id INTO v_user_id;

  IF v_was_new AND p_referral_payload IS NOT NULL AND p_referral_payload <> '' THEN
    IF p_referral_payload ~ '^ref_[A-Za-z0-9]{4,16}$' THEN
      v_ref_code := substring(p_referral_payload FROM 5);
      SELECT id INTO v_referrer_id
      FROM users
      WHERE referral_code = v_ref_code AND referral_active = TRUE;
      IF FOUND AND v_referrer_id <> v_user_id THEN
        UPDATE users SET referred_by_user_id = v_referrer_id, referred_by_type = 'user',
          referred_by_merchant_link_id = NULL, attributed_at = NOW(), updated_at = NOW()
        WHERE id = v_user_id AND referred_by_user_id IS NULL;
      END IF;
    ELSIF p_referral_payload ~ '^merchant_[A-Za-z0-9]{4,32}$' THEN
      SELECT * INTO v_link FROM merchant_referral_links
      WHERE code = substring(p_referral_payload FROM 10) AND active = TRUE;
      IF FOUND AND v_link.owner_user_id <> v_user_id THEN
        UPDATE users SET referred_by_user_id = v_link.owner_user_id, referred_by_type = 'merchant',
          referred_by_merchant_link_id = v_link.id, attributed_at = NOW(), updated_at = NOW()
        WHERE id = v_user_id AND referred_by_user_id IS NULL;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM users WHERE id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION ensure_bot_user(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_bot_user(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- Rebuild the commission guard. Disabled customer referral codes stop future
-- referral commissions; historical attribution and commission rows remain.
CREATE OR REPLACE FUNCTION apply_order_referral_commission(
  p_order_id BIGINT,
  p_buyer_user_id BIGINT,
  p_order_total NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_buyer users%ROWTYPE;
  v_link merchant_referral_links%ROWTYPE;
  v_beneficiary_id BIGINT;
  v_percent NUMERIC;
  v_commission NUMERIC(20,8);
  v_commission_id BIGINT;
  v_balance NUMERIC(20,8);
  v_referral_enabled TEXT;
  v_source_type TEXT;
  v_source_id BIGINT;
  v_referrer_active BOOLEAN;
BEGIN
  IF p_order_total IS NULL OR p_order_total <= 0 THEN RETURN; END IF;

  SELECT * INTO v_buyer FROM users WHERE id = p_buyer_user_id;
  IF NOT FOUND OR v_buyer.referred_by_user_id IS NULL OR v_buyer.referred_by_type IS NULL THEN RETURN; END IF;
  IF v_buyer.referred_by_user_id = p_buyer_user_id THEN RETURN; END IF;

  IF v_buyer.referred_by_type = 'user' THEN
    SELECT value INTO v_referral_enabled FROM bot_settings WHERE key = 'referral_enabled';
    IF COALESCE(lower(v_referral_enabled), 'false') <> 'true' THEN RETURN; END IF;

    SELECT referral_active INTO v_referrer_active FROM users WHERE id = v_buyer.referred_by_user_id;
    IF COALESCE(v_referrer_active, FALSE) = FALSE THEN RETURN; END IF;

    v_beneficiary_id := v_buyer.referred_by_user_id;
    v_source_type := 'user_referral';
    v_source_id := NULL;
    SELECT COALESCE(NULLIF(value, '')::NUMERIC, 10) INTO v_percent
      FROM bot_settings WHERE key = 'referral_commission_percent';
    v_percent := COALESCE(v_percent, 10);
  ELSIF v_buyer.referred_by_type = 'merchant' THEN
    IF v_buyer.referred_by_merchant_link_id IS NULL THEN RETURN; END IF;
    SELECT * INTO v_link FROM merchant_referral_links WHERE id = v_buyer.referred_by_merchant_link_id;
    IF NOT FOUND OR NOT v_link.active THEN RETURN; END IF;
    v_beneficiary_id := v_link.owner_user_id;
    v_source_type := 'merchant_referral';
    v_source_id := v_link.id;
    v_percent := v_link.commission_percent;
  ELSE
    RETURN;
  END IF;

  IF v_beneficiary_id IS NULL OR v_beneficiary_id = p_buyer_user_id OR v_percent IS NULL OR v_percent <= 0 THEN RETURN; END IF;

  v_commission := round(p_order_total * v_percent / 100, 8);
  IF v_commission <= 0 THEN RETURN; END IF;

  INSERT INTO referral_commissions(
    order_id, beneficiary_user_id, referred_user_id, source_type, source_id,
    commission_percent, order_amount, commission_amount, status
  ) VALUES (
    p_order_id, v_beneficiary_id, p_buyer_user_id, v_source_type, v_source_id,
    v_percent, p_order_total, v_commission, 'credited'
  )
  ON CONFLICT (order_id) DO NOTHING
  RETURNING id INTO v_commission_id;

  IF v_commission_id IS NULL THEN RETURN; END IF;

  UPDATE users SET wallet_balance = wallet_balance + v_commission, updated_at = NOW()
  WHERE id = v_beneficiary_id RETURNING wallet_balance INTO v_balance;

  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (
    v_beneficiary_id, 'referral_commission', v_commission, v_balance, 'referral_commission', p_order_id::TEXT,
    CASE WHEN v_source_type = 'merchant_referral' THEN 'Merchant referral commission for order #' || p_order_id
      ELSE 'Referral commission for order #' || p_order_id END
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_order_referral_commission(BIGINT,BIGINT,NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_order_referral_commission(BIGINT,BIGINT,NUMERIC) TO service_role;
