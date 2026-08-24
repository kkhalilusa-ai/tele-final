
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
