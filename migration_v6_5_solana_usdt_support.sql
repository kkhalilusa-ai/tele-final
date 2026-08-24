-- v6.5: Solana deposits are quoted in USDT and settled manually in SOL.
-- Support Inbox can open an existing user's support conversation by Telegram ID.

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS crypto_amount NUMERIC(30,9);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS price_used NUMERIC(30,12);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS price_source TEXT;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS price_at TIMESTAMPTZ;

UPDATE payment_settings
SET public_config = jsonb_set(
  jsonb_set(
    jsonb_set(COALESCE(public_config, '{}'::jsonb), '{minimum}', '"1"'::jsonb, TRUE),
    '{maximum}', COALESCE(public_config->'maximum', '"50"'::jsonb), TRUE
  ),
  '{presets}', '["1","2","5","10","20"]'::jsonb, TRUE
), updated_at = NOW()
WHERE method_key = 'solana';

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

GRANT EXECUTE ON FUNCTION create_deposit(BIGINT,TEXT,NUMERIC,INTEGER,TEXT,NUMERIC,NUMERIC,TEXT,TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION approve_manual_deposit(UUID,BIGINT) TO service_role;
