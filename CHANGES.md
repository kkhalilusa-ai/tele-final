# CHANGES — Production Upgrade v6.2

## v6.2 — Multi-Delivery / Custom Emoji / Chat Cleanup

- إصلاح تسليم الكميات 2/5/10 من المخزون الفريد ضمن transaction واحدة وRollback كامل عند نقص أي قطعة.
- فحص صارم لعدد بيانات التسليم في PostgreSQL وNode.js وMy Orders.
- تقسيم رسائل التسليم الطويلة عند حدود القطع دون قطع حساب أو رابط أو كلمة مرور.
- Custom Emojis متحقق منها عبر Telegram مع Cache وAdmin Test وUnicode fallback.
- تنظيف DB-backed للرسائل المؤقتة مع حماية دائمة للتسليم والدفع والدعم.
- Migration مستقل: `migration_v6_2_multi_delivery_chat_cleanup.sql`.
- `npm run check`: PASS. `npm test`: 60/60 PASS.

## v6 — UI / BEP20 / Binance Order ID

- استبدال طرق الإيداع الجديدة من USDT TRC20 إلى USDT (BEP20)؛ السجلات القديمة محفوظة تاريخيًا فقط.
- تحقق Binance يقبل `orderId` الرقمي فقط، يرفض Transaction ID، ويمنع إعادة استخدام Order ID داخل اعتماد ذري للمحفظة.
- صفحة Admin لسجل Binance Pay مع Order/Transaction search، تاريخ، عملة، incoming filter، cache، refresh وTest API بدون كشف secrets.
- Product Details أقرب للمرجع، زر Buy Now واحد، ثم Reply Keyboard كبير يعرض 1..Stock أو Presets/Custom للـStock الكبير.
- تحكم Admin في Main Menu enable/disable/layout، labels EN/AR/HI، كمية/threshold/presets/columns، وTelegram Custom Emoji IDs مع Unicode fallback.
- BEP20 deposits تستخدم Network TxID وتدخل pending review مع Approve/Reject فعليين من Admin.
- Scheduled Flash Sales تضبط السعر في الوقت المحدد، تستخدم Price Drop notification الحالية، ثم تستعيد السعر الأصلي بأمان.
- Migration مستقل: `migration_v6_ui_bep20_binance_history.sql`، و`database.sql` محدث للتثبيت الجديد.
- `npm run check`: PASS. `npm test`: 44/44 PASS.

## Historical — Production Upgrade v5

## Catalog / Telegram UX

- `products.category_id` أصبح Nullable؛ لا يوجد اعتماد على Category وهمية للـOther Products.
- Category Layout عالمي: Full Width / Two Columns / Auto مع Override لكل Category.
- Product buttons Full Width، وOther Products تظهر في الصفحة الرئيسية مع stock indicator.
- Product Details تستخدم رموز موحدة للنوع/التسليم/الضمان/السعر/المخزون/المباع وBulk Pricing.
- Persistent Reply Keyboard لـShop + Deposit مع نصوص متعددة اللغات وقابلة للتعديل من Admin.
- Navigation Message Manager يقلل تراكم القوائم القديمة ويحفظ إيصالات الشراء/Delivery كرسائل مهمة.
- دعم `/start product_<id>` لفتح المنتج مباشرة من الإشعارات الخارجية.

## Notifications Automation

- إضافة قواعد مستقلة لـNew Product, Restock, Price Drop, Selling Fast, Out Of Stock, Product Update.
- Destination modes للمستخدمين والقنوات والمجموعات وCustom Chat وMultiple Destinations.
- Test Notification من Admin مع إظهار Telegram permission errors بشكل واضح.
- Queue مستمرة في PostgreSQL/Supabase: queued / processing / completed / failed / cancelled.
- Worker ذري يستخدم `FOR UPDATE SKIP LOCKED`، إرسال متدرج، Telegram 429 `retry_after` و5xx backoff.
- Dedup/Cooldown persistent، Price Drop لا يتكرر لنفس السعر، New Product مرة واحدة، Selling Fast على threshold crossing فقط.
- عند عبور عدة thresholds في تغيير Stock واحد يرسل تنبيه Selling Fast واحد بدل spam.
- History + Live progress + Cancel + Retry Failed (يعيد failed recipients فقط).

## Admin Panel / Live UX

- Theme Switcher: Dark / Light / System مع `localStorage` و`prefers-color-scheme`.
- Products form يدعم No Category وNotification mode.
- Categories form يدعم Telegram Layout Override.
- Bot Settings تتحكم في Catalog layout وOther Products وNavigation cleanup وPersistent Keyboard labels.
- صفحة Automation كاملة للقواعد والوجهات والـjobs.
- Dashboard: Active Users, Low Stock, Latest Support وQuick Actions.
- توسيع Realtime resource map لجداول notification/user UI state الجديدة.

## Database / Security / Compatibility

- Migration v5 Additive/Idempotent قدر الإمكان ولا يحتوي `DROP TABLE`.
- تحويل منتجات Category القديمة المسماة `Other Product` إلى `category_id = NULL` مع الحفاظ على المنتجات والـIDs.
- إضافة RLS للجداول الجديدة ومنع anon/authenticated من الوصول الإداري، مع service_role Server-Side فقط.
- المحافظة على atomic purchase, wallet deduction, encrypted unique inventory, Binance Pay, USDT, FAQ, Support, Refunds وAudit Log.
- لا توجد Environment Variables جديدة مطلوبة في v5.

## Verification

- `npm run check` يشمل خدمة Notifications الجديدة ويجتاز فحص syntax.
- إضافة `test/v5Upgrade.test.js` لتغطية Layout, Other Products, Persistent Keyboard, migration contracts وautomation/deep-link contracts.
- في بيئة البناء الحالية فشل تنزيل npm dependencies بسبب registry/DNS (`EAI_AGAIN`)، لذلك الاختبارات التي لا تحتاج dependencies الخارجية تم تشغيلها مباشرة، بينما التشغيل الكامل يجب إعادة تنفيذه بعد `npm ci` في Render/بيئة متصلة بالـnpm registry.

---

## Historical — Production Upgrade v4

## Telegram UI

- إعادة ترتيب Main Menu ليطابق المرجع قدر الإمكان: Products / Deposit / My Orders / Support / About / Channel / More.
- إعادة تصميم Categories إلى صفوف ثنائية مع emoji وعدد المنتجات.
- Product list يعرض الاسم والمدة والسعر والمخزون وحالة Out بشكل واضح.
- Product Details أصبح ديناميكيًا ويعرض Product Type، Delivery ETA، Warranty، Price، Stock، Sold وBulk Pricing.
- Purchase Confirmation أصبح قريبًا من المرجع: Product، Quantity، Unit Price، Subtotal، Total، Wallet Balance وShortfall.
- بعد الشراء يستخدم البوت الإعدادات والروابط الديناميكية بدل الرجوع إلى config ثابت.

## Products / Categories

- إضافة `subtitle`, `duration`, `product_type`, `currency`, `product_status`, `sold_display_offset`.
- إضافة Product Status: active / inactive / out_of_stock / draft.
- إضافة Category emoji وإدارة كاملة للـCategory من الويب.
- إضافة/ضمان Category باسم `Other Product` دون حذف أي Category موجودة.
- Product archive أصبح Soft Archive (`draft`) بدل حذف السجل.
- Out-of-stock products تبقى قابلة للظهور باللون/الحالة المناسبة بينما الشراء يبقى محميًا Backend.

## Bulk Pricing

- إبقاء حساب السعر داخل PostgreSQL `purchase_product_v2`.
- إزالة الحد البرمجي القديم لعدد tiers في Admin API؛ الحجم العملي يبقى مقيدًا بحد طلب JSON.
- دعم min/max/open-ended tier.

## Inventory

- الحفاظ على unique encrypted inventory وatomic purchase الموجودين وتوسيع الإدارة.
- TXT/CSV upload من Admin UI.
- Export filtered inventory من Admin فقط مع فك التشفير Server-Side.
- Delete unsold/unreserved item.
- Search/filter/status/reveal/enable/disable موجودة في نفس Inventory manager.
- Sold items لا تعاد إلى available ولا تباع مرتين.

## Bot Settings / Links

- إضافة `bot_settings` وتوصيلها فعليًا بالـBot وAdmin.
- إعدادات تشمل welcome/start/store/support/about/footer/terms/contact/payment/order messages/button labels/language/maintenance/order limits/out-of-stock text.
- إضافة `bot_links` CRUD: key/text/url/active/sort order.
- Support/Channel لديها Environment fallback فقط إذا لا توجد قيمة Database.

## FAQ

- إضافة جدول `faqs`.
- Admin CRUD + language + enable/disable + sort order.
- Telegram FAQ يقرأ الأسئلة والأجوبة مباشرة من Database.

## Customer Chat / Support Inbox

- إضافة `support_conversations` و`support_messages`.
- Chat in Bot يدخل وضع support chat ويحفظ رسائل المستخدم.
- Support Inbox في Admin مع search/status/unread/history.
- فتح المحادثة يعلّم رسائل المستخدم كمقروءة.
- Close/Reopen conversation.
- Reply from Admin يصل مباشرة إلى Telegram ويتم حفظه في المحادثة.
- إضافة آخر 5 Orders للمستخدم داخل المحادثة لتسهيل الدعم.

## Payment Settings

- إضافة `payment_settings`.
- Enable/Disable Binance وUSDT من Admin.
- Display name وpublic JSON config من Admin.
- مفاتيح Binance والـprivate secrets لم تنتقل لقاعدة البيانات وتبقى Environment Variables.

## Dashboard / Realtime

- إضافة `admin_dashboard_stats()`.
- Dashboard يعرض revenue/orders/completed/pending/users/new users/products/out-of-stock/messages waiting إضافة إلى الإحصاءات القديمة.
- الجداول الجديدة مضافة إلى Supabase Realtime publication عندما تكون متاحة.
- SSE + reconnect + polling fallback بقيت محفوظة.

## Database / Migration

- `migration.sql` مستقل لترقية قاعدة البيانات الحالية فقط.
- لا يوجد `DROP TABLE` ولا مسح لبيانات users/products/orders.
- `database.sql` يحتوي أيضًا upgrade v4 ليعمل في البيئات الجديدة.
- تحديث `product_catalog` لإظهار `real_sold_count` و`sold_count` مع offset واضح.
- تحديث `category_catalog` لتمييز available مقابل visible active/out-of-stock products.

## Security / Integrity

- الحفاظ على Admin auth, signed sessions, CSRF, same-origin checks, CSP/security headers.
- الأسعار والـtotals لا تؤخذ من Client.
- unique inventory reservation/purchase يبقى transaction-safe باستخدام row locks و`FOR UPDATE SKIP LOCKED`.
- API secrets لا تعاد إلى frontend.
- Inventory export/reveal عمليات Admin محمية ومؤرشفة في audit log.

## Tests / Verification

- تحديث contract test للـMain Menu الجديد.
- إضافة contract coverage لـbot settings/links/FAQ/support/payment tables/routes.
- `npm run check` يمر بنجاح.
- static Node test subset: 24/24 passed في بيئة البناء.
- تم التحقق من JavaScript المضمّن داخل Admin Panel عبر `new Function()` syntax validation.
- الاختبار الحي ضد Telegram/Supabase يحتاج Environment secrets فعلية ولا يتم تضمينها في الحزمة.

## v5.1 — PostgreSQL View Migration Fix

- Fixed Supabase/PostgreSQL `ERROR: 42P16: cannot drop columns from view` when rerunning `migration.sql`.
- `product_catalog` and dependent `category_catalog` are now dropped/recreated safely instead of relying on incompatible `CREATE OR REPLACE VIEW` shape changes.
- Dropping these views is non-destructive: no users, products, orders, inventory, wallets, or payments are deleted.
- Re-applies server-only catalog view permissions after recreation.

## v5.0.1 admin UI / wallet hotfix

- Fixed Bot Settings and Payment Settings rendering: native `appendChild()` accepts only one node, so extra panels were silently ignored.
- Restored the Wallet toolbar affected by the same rendering mistake.
- Added an atomic, idempotent `admin_adjust_wallet` PostgreSQL RPC.
- Added authenticated + CSRF-protected wallet adjustment controls under Users → Details, with Telegram-ID confirmation, audit logging, immutable wallet transaction history, and negative-balance protection.
