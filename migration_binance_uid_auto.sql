-- Binance Pay automatic verification via the signed Binance account API
-- Safe additive migration for an existing Supabase database.

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS received_amount NUMERIC(20,8);

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

REVOKE ALL ON FUNCTION approve_binance_history_deposit(UUID, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_binance_history_deposit(UUID, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) TO service_role;
