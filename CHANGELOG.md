# Changelog

## 6.2.0 — Atomic Multi-Delivery + Safe Chat Cleanup

- Re-deploy `purchase_product_v2` through an additive migration with exact selected, updated and encrypted-array counts.
- Reject partial instant orders before commit and validate delivery count in checkout and My Orders.
- Split large Telegram deliveries at whole-item boundaries; oversized single items use a text document.
- Validate Custom Emoji IDs with Telegram, cache results, support message/button icons and Unicode fallback.
- Persist last user/transient bot message IDs and batch cosmetic cleanup without touching permanent delivery, payment or support messages.
- Add 15 focused v6.2 scenarios; final suite is 60/60 passing.

## 5.0.0 — Catalog + Automation + Admin UX

- Nullable product categories and real Other Products section.
- Configurable category layouts and persistent Telegram Shop/Deposit keyboard.
- Navigation cleanup with preserved purchase/delivery receipts and product deep links.
- Database-backed automatic product notification rules, destinations, queue, dedup, retry/backoff and history.
- Dark/Light/System Admin themes, Automation management, richer Dashboard and realtime resources.
- Additive v5 migration with no new environment variables.


## 4.0.0 — Dynamic Store/Admin Upgrade

- Telegram UI rebuilt around the supplied store screenshots.
- Dynamic product metadata, statuses, sold counter and unlimited bulk tier definitions.
- Other Product category and expanded category/product administration.
- Bot Settings, Bot Links, FAQ and Payment Settings backed by Supabase.
- Customer Chat / Support Inbox with replies from the web admin and recent order context.
- Inventory TXT/CSV import, filtered export and safe deletion of unsold items.
- New additive `migration.sql` with no table/data deletion.
- Dashboard revenue/order/user/product/support metrics and realtime resources.
- Updated contract tests for the new UI and v4 database/admin capabilities.

## 3.0.1 — Render Admin Login R4

- Accept Chrome's browser-controlled `Sec-Fetch-Site: same-origin` signal when
  Render exposes a mismatched internal proxy host or protocol.
- Keep the signed, short-lived pre-auth CSRF token mandatory and continue to
  reject `cross-site` login requests.
- Add explicit safe diagnostics for origin and pre-auth checks, without logging
  credentials or secrets.
- Add unit and integration regression coverage for the observed Render 403.

## 3.0.0 — Full Store Upgrade

- ربط لوحة الإدارة فعليًا بتطبيق Express ومسار التشغيل الرئيسي.
- إضافة Supabase Realtime + SSE + Heartbeat + Reconnect + Polling fallback.
- إضافة مؤشر Live وLast updated وتحديث الأقسام دون Full Page Reload.
- توسيع نموذج المنتج بالصورة، نوع التسليم، ETA، الضمان، الكميات، Pre-Order، Bulk Pricing، Emoji والترتيب.
- إضافة مخزون فريد مشفّر AES-256-GCM مع Bulk Import وMasked Preview وAudited Reveal.
- إضافة `purchase_product_v2` للشراء الذري متعدد الكمية مع `FOR UPDATE SKIP LOCKED` وIdempotency.
- إضافة Instant Delivery وManual Fulfillment Queue وإشعارات التسليم.
- إعادة تصميم Main Menu إلى أربعة صفوف بعمودين وإضافة Pre-Orders وRefund وVIP.
- إضافة شاشة منتجات محسّنة وبطاقات تفاصيل وصور وOut-of-stock واضح.
- إضافة My Orders بفلاتر وملخص وتفاصيل وتسليم خاص بكل طلب.
- إضافة Refund Requests واعتماد/رفض ذري مع إعادة المحفظة.
- إصلاح Same-Origin لتسجيل الدخول خلف Render Proxy مع الحفاظ على CSRF.
- إضافة Audit Log للمنتجات والمخزون والتسليم والإيداعات والاسترجاعات.
- توسيع Migration دون حذف البيانات وتحويل المنتجات القديمة إلى Manual افتراضيًا.
- إضافة اختبارات التشفير، Render proxy، الترجمة، العقود الذرّية والتزامن.
