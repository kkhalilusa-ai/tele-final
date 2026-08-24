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
