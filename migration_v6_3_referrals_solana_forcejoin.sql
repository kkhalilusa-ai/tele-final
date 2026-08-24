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
  '{"network_name":"Solana","minimum":"0.05","maximum":"50","presets":[1,2,5],"expiration_minutes":30,"address":"","instructions":"Send exactly the requested amount, then submit the transaction signature."}'::JSONB
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
  v_currency TEXT;
  v_network TEXT;
BEGIN
  IF p_method NOT IN ('binance', 'usdt_bep20', 'solana') THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
  IF p_requested_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_expiry_minutes < 1 OR p_expiry_minutes > 1440 THEN RAISE EXCEPTION 'INVALID_EXPIRY'; END IF;
  IF p_method = 'usdt_bep20' AND (p_payment_address IS NULL OR p_payment_address !~ '^0x[0-9A-Fa-f]{40}$') THEN
    RAISE EXCEPTION 'INVALID_BEP20_ADDRESS';
  END IF;
  IF p_method = 'solana' AND (p_payment_address IS NULL OR p_payment_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN
    RAISE EXCEPTION 'INVALID_SOLANA_ADDRESS';
  END IF;

  SELECT * INTO v_user FROM users WHERE telegram_id = p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_user.is_suspended THEN RAISE EXCEPTION 'USER_SUSPENDED'; END IF;

  v_currency := CASE WHEN p_method = 'solana' THEN 'SOL' ELSE 'USDT' END;
  v_network := CASE WHEN p_method = 'usdt_bep20' THEN 'BEP20' WHEN p_method = 'solana' THEN 'Solana' ELSE NULL END;

  v_id := gen_random_uuid();
  v_code := 'D' || substring(replace(v_id::TEXT, '-', '') FROM 1 FOR 24);
  v_expires := NOW() + make_interval(mins => p_expiry_minutes);
  RETURN QUERY
  INSERT INTO deposits(
    id, deposit_code, user_id, requested_amount, expected_amount, currency, network,
    payment_method, payment_address, expires_at
  ) VALUES (
    v_id, v_code, v_user.id, p_requested_amount, p_requested_amount, v_currency, v_network,
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
DECLARE v_deposit deposits%ROWTYPE; v_user users%ROWTYPE; v_balance NUMERIC(20,8); v_description TEXT;
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
  IF v_deposit.payment_method NOT IN ('usdt_bep20', 'usdt_trc20', 'solana') OR v_deposit.status <> 'pending_review' OR v_deposit.transaction_id IS NULL THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_REVIEWABLE';
  END IF;
  v_description := CASE v_deposit.payment_method
    WHEN 'usdt_bep20' THEN 'USDT BEP20 deposit'
    WHEN 'solana' THEN 'Solana (SOL) deposit'
    ELSE 'Legacy USDT TRC20 deposit' END;
  UPDATE users SET wallet_balance = wallet_balance + v_deposit.expected_amount, updated_at = NOW()
    WHERE users.id = v_user.id RETURNING wallet_balance INTO v_balance;
  INSERT INTO wallet_transactions(user_id, type, amount, balance_after, reference_type, reference_id, description)
  VALUES (v_user.id, 'deposit', v_deposit.expected_amount, v_balance, 'deposit', v_deposit.id::TEXT, v_description);
  UPDATE deposits SET status = 'approved', reservation_active = FALSE, paid_at = NOW(), approved_at = NOW(),
    reviewed_at = NOW(), approved_by = p_admin_telegram_id, updated_at = NOW() WHERE deposits.id = p_deposit_id;
  RETURN QUERY SELECT v_deposit.id, v_user.telegram_id, v_deposit.expected_amount, 'approved'::TEXT, TRUE;
END;
$$;

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
