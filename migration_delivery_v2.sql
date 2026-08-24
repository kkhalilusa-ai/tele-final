BEGIN;

-- Delivery renderer v2: additive order snapshot + centralized delivery UI support.
-- Safe to run on existing databases; no data is deleted or rewritten.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN orders.delivery_snapshot IS
  'Immutable product/customer-content snapshot used by the centralized delivery renderer.';

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


REVOKE ALL ON FUNCTION purchase_product_v2(BIGINT,BIGINT,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purchase_product_v2(BIGINT,BIGINT,INTEGER,TEXT) TO service_role;

COMMIT;
