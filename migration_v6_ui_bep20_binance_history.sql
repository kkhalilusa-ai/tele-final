-- Telegram Store Bot v6: screenshot-inspired UI, BEP20 and Order-ID-only Binance verification.
-- Safe for the current production database: no user, product, order, wallet or history rows are removed.

BEGIN;

ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_payment_method_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_payment_method_check
  CHECK (payment_method IN ('binance', 'usdt_bep20', 'usdt_trc20'));

INSERT INTO payment_settings(method_key, display_name, enabled, public_config)
VALUES (
  'usdt_bep20', 'USDT (BEP20)', TRUE,
  '{"network_name":"BNB Smart Chain (BEP20)","minimum":"1","maximum":"1000","presets":[5,10,25,50],"expiration_minutes":30,"address":"","instructions":"Add any withdrawal fee on top so the full requested amount arrives."}'::JSONB
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
  ('success_custom_emoji_id','','Telegram custom emoji ID for success messages',TRUE)
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
