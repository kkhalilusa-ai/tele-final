# Telegram Store Bot — Production Upgrade v6.2

نسخة تطوير مباشرة للمشروع الحالي، وليست مشروعًا جديدًا. البنية بقيت Node.js + Express + Telegraf + Supabase/PostgreSQL، وتم توسيع نفس الخدمات والجداول والـAdmin Panel بدون حذف بيانات المتجر الحالية.

## أهم التغييرات

- إصلاح التسليم التلقائي متعدد الكمية: الطلب يسحب العدد كاملًا ذرّيًا، ويربط كل العناصر بنفس الطلب، ويرفض العملية كاملة قبل الخصم إذا لم تتوفر الكمية المطلوبة.
- فحص تطابق `deliveries.length === order.quantity` في الشراء وMy Orders، مع تقسيم التسليم الطويل عند حدود العناصر فقط.
- تنظيف محادثة آمن محفوظ في `user_ui_state`: الاحتفاظ بآخر رسالة للعميل وتنظيف الرسائل المؤقتة دون تسجيل رسائل التسليم والدفع والدعم كرسائل قابلة للحذف.
- Telegram Custom Emojis حقيقية بعد التحقق عبر `getCustomEmojiStickers`، مع Cache وUnicode fallback وزر **Test Custom Emojis** في Admin Panel.
- واجهة Telegram أقرب للصور المرجعية: Main Menu، Categories، Product list، Product details، Purchase confirmation، Support.
- بطاقة منتج ديناميكية تعرض الاسم/المدة، نوع المنتج، زمن التسليم، الضمان، السعر، المخزون، المباع، وBulk Pricing.
- Product Status: `active`, `inactive`, `out_of_stock`, `draft`.
- المنتجات يمكن أن تكون بدون Category فعليًا (`category_id = NULL`) وتظهر تحت `📦 Other Products` بدون إنشاء Category وهمية.
- Bulk Pricing بعدد Tiers غير محدود منطقيًا ضمن حجم الطلب، والسعر النهائي يحسب Server-Side داخل PostgreSQL.
- Unique Inventory للمنتجات Instant: كل سطر عنصر مستقل، تشفير AES-256-GCM، ومنع إعادة بيع نفس العنصر عبر transaction و`FOR UPDATE SKIP LOCKED`.
- Inventory Admin: لصق List، TXT/CSV upload، filter/search، reveal audited، disable/enable، delete unsold، export.
- Bot Links من Admin Panel بدل Hardcode: Support، Channel، WhatsApp، Website، Terms أو أي زر HTTPS مخصص.
- Bot Settings من Admin Panel: welcome/start/support/about/footer/terms/payment messages/button texts/language/maintenance/order limits وغيرها.
- FAQ Management كامل من Admin Panel ويقرأه البوت من قاعدة البيانات.
- Chat With Us / Support Inbox: رسائل المستخدم تظهر في لوحة الإدارة والرد من الويب يصل مباشرة إلى Telegram، مع open/close/reopen/read/search وRecent Orders للمستخدم.
- Payment Settings: تشغيل/تعطيل الطرق وتعديل الاسم والبيانات العامة فقط؛ الـAPI secrets تبقى في Environment Variables.
- Dashboard أوسع: revenue، orders، users، products، out-of-stock، messages waiting، stock، deposits، refunds.
- لوحة الإدارة تتحدث عبر SSE/Realtime مع Polling احتياطي، ومتجاوبة مع الهاتف والتابلت والكمبيوتر.

## ملفات مهمة

```text
.
├── index.js
├── bot.js
├── admin.js
├── database.sql        # schema كامل لإنشاء/ترقية بيئة جديدة
├── migration.sql       # ترقية آمنة v4 → v5 لقاعدة بيانات المشروع الحالية
├── migration_binance_uid_auto.sql # تفعيل تحقق Binance Pay التلقائي من سجل الحساب
├── migration_v6_ui_bep20_binance_history.sql # ترقية v6 الآمنة
├── migration_v6_2_multi_delivery_chat_cleanup.sql # ترقية v6.2 المطلوبة
├── .env.example
├── CHANGES.md
├── CHANGELOG.md
├── src/
└── test/
```

## 1) ترقية قاعدة البيانات الحالية — الموصى به

> خذ Backup من Supabase قبل أي Migration إنتاجي.

إذا قاعدة بيانات البوت الحالية موجودة بالفعل: شغّل ترقيات v5/v6 القديمة عند الحاجة، ثم شغّل **`migration_v6_2_multi_delivery_chat_cleanup.sql` أخيرًا**. هذا الملف يعيد نشر `purchase_product_v2` الآمنة ويضيف حالة تنظيف المحادثة وإعداد تشغيل Custom Emojis بدون حذف أي بيانات.

الـmigration Additive ولا يحتوي `DROP TABLE` ولا يمسح products/users/orders. يضيف الحقول والجداول الجديدة ويعيد إنشاء Views المطلوبة، ويحوّل منتجات `Other Product` القديمة إلى `category_id = NULL` بدون حذف المنتجات.

إذا كنت تنشئ قاعدة بيانات جديدة تمامًا، يمكنك تشغيل `database.sql` كاملًا بدلًا من ذلك.

### تطبيق v6.2 على Supabase وRender

1. خذ Backup ثم افتح **Supabase → SQL Editor**.
2. الصق وشغّل `migration_v6_2_multi_delivery_chat_cleanup.sql` مرة واحدة.
3. ارفع ملفات المشروع إلى GitHub/Render ثم استخدم Build Command: `npm ci` وStart Command: `npm start`.
4. لا توجد متغيرات بيئة جديدة في v6.2؛ أبقِ متغيرات النسخة الحالية كما هي.
5. بعد نشر Render شغّل `/start` واختبر شراء كمية 5 من منتج Instant ثم افتح الطلب من My Orders.

### متطلبات Telegram Custom Emojis

- أدخل IDs حقيقية من حقل `custom_emoji_id`؛ لا يضع المشروع أي IDs عشوائية.
- البوت يتحقق منها عبر `getCustomEmojiStickers` ويستخدم Unicode تلقائيًا عند ID فارغ/غير صالح أو عند تعذر الميزة.
- حسب Telegram Bot API، ظهور Custom Emoji داخل الرسائل والأزرار يتطلب أن يكون مالك البوت Telegram Premium للرسائل المباشرة المدعومة، أو أن يكون البوت مؤهلًا عبر additional usernames المشتراة على Fragment.
- استخدم **Admin → Bot Settings → Test Custom Emojis**؛ النتيجة تبيّن عدد IDs الصحيحة وأيها Animated/Video.
- لا يلزم تحديث Telegraf لهذه الميزة؛ المشروع يرسل حقول Bot API المدعومة مباشرة مع الحفاظ على Telegraf 4.16.3.

### ما يضيفه `migration.sql`

- `users.last_name`
- `categories.emoji`
- Metadata جديدة للمنتجات: subtitle/duration/product_type/currency/product_status/sold_display_offset
- `bot_settings`
- `bot_links`
- `faqs`
- `support_conversations`
- `support_messages`
- `payment_settings`
- Views محدثة لـ`product_catalog` و`category_catalog`
- RPCs للدعم وإحصاءات Dashboard
- `products.category_id` يصبح Nullable لدعم Other Products الحقيقي
- `categories.layout_override` و`products.notification_mode`
- `user_ui_state` لحفظ آخر Navigation message وحالة Persistent Keyboard
- `notification_rules`, `notification_destinations`, `notification_jobs`, `notification_job_deliveries`, `product_notification_state`
- Queue claim ذري بـ`FOR UPDATE SKIP LOCKED` لنظام الإشعارات
- Realtime registration للجداول الجديدة عندما يكون `supabase_realtime` متاحًا

## أهم إضافات v5

- **Catalog Layout** من Admin: Full Width / Two Columns / Auto مع Override لكل Category.
- **Other Products الحقيقي**: المنتج يمكن إنشاؤه بدون Category ويظهر في Products Main Page.
- Product details موحدة بالإيموجي: `🛡️ Warranty`, `💵 Price`, `📦 Stock`, `🛒 Sold`, `🔗/📎 Type`, `⏱️ Delivery Time`.
- **Persistent Bottom Keyboard**: `➕ Deposit` + `🛍️ Shop` مع نصوص قابلة للتعديل.
- **Navigation Message Manager** يحاول تعديل القائمة الحالية أو حذف القائمة السابقة، مع إبقاء إيصالات الشراء والتسليم المهمة.
- Deep links: `/start product_<id>` لفتح المنتج مباشرة من Channel/Group notifications.
- **Notifications / Automation** من Admin: New Product, Restock, Price Drop, Selling Fast, Out Of Stock, Product Update.
- Destinations: Users / Channel / Group / Custom Chat / Users + Channel / Users + Group / Multiple.
- Database-backed Queue، retry/backoff، احترام Telegram `retry_after`، dedup/cooldown/threshold state، Test Notification، Live job progress، Cancel وRetry Failed.
- **Dark / Light / System** theme switcher محفوظ في `localStorage`.
- Dashboard موسعة بـActive Users, Low Stock, Latest Support وQuick Actions.

### NEW ENV VARIABLES ONLY — v6

- `USDT_BEP20_ADDRESS`
- `USDT_BEP20_MIN_DEPOSIT`
- `USDT_BEP20_MAX_DEPOSIT`
- `USDT_BEP20_EXPIRY_MINUTES`
- `USDT_BEP20_NETWORK_NAME`

يمكن ضبط القيم العامة نفسها من **Admin → Payment Settings**؛ متغيرات البيئة تعمل كـfallback آمن. متغيرات `USDT_TRC20_*` لم تعد تستخدم لإنشاء دفعات جديدة.

## 2) Environment Variables

انسخ:

```bash
cp .env.example .env
```

### Required

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Telegram bot token من BotFather |
| `ADMIN_IDS` | Telegram admin IDs مفصولة بفواصل |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role key — Server only |
| `ADMIN_WEB_USERNAME` | Web Admin username |
| `ADMIN_WEB_PASSWORD` | Web Admin password |
| `ADMIN_WEB_TELEGRAM_ID` | Telegram ID للأدمن ويجب أن يكون داخل `ADMIN_IDS` |
| `ADMIN_SESSION_SECRET` | Session/CSRF secret قوي |
| `INVENTORY_ENCRYPTION_KEY` | 32-byte key لتشفير عناصر المخزون |

### Telegram / Deployment

| Variable | Purpose |
|---|---|
| `PORT` | يحددها Render عادةً |
| `WEBHOOK_URL` | Public service URL؛ اتركه فارغًا محليًا لاستخدام polling |
| `PUBLIC_BASE_URL` | Public HTTPS URL للـAdmin same-origin checks |
| `TELEGRAM_WEBHOOK_SECRET` | Secret لحماية Telegram webhook |
| `DEFAULT_LANGUAGE` | `en`, `ar`, `hi` |

### Public fallback links

هذه فقط fallback عند عدم وجود قيم في **Admin → Bot Links**:

- `SUPPORT_USERNAME`
- `SUPPORT_URL`
- `CHANNEL_URL`
- `VIP_URL`

### Binance Pay — Auto Verify by Account API

- `BINANCE_PAY_AUTO_ENABLED=true`
- `BINANCE_API_KEY` — API Key عادي من حساب Binance بصلاحية قراءة فقط
- `BINANCE_API_SECRET` — Secret لنفس المفتاح
- `BINANCE_API_BASE_URL=https://api.binance.com`
- `BINANCE_API_RECV_WINDOW=5000`
- `BINANCE_API_TIMEOUT_MS=8000`
- `BINANCE_PAY_ID` — اختياري للعرض: الرقم الذي يرسله العميل إليه داخل Binance Pay (إذا كان مختلفًا عن UID)
- `BINANCE_UID` — **مطلوب**: UID للحساب المستلم ويُستخدم لمطابقة `receiverInfo.binanceId`
- `BINANCE_PAYMENT_NAME`
- `BINANCE_CURRENCY=USDT`
- `BINANCE_PAY_EXPIRY_MINUTES=20`
- `BINANCE_MIN_PAYMENT=0.01`

التحقق هنا لا يستخدم Merchant Checkout أو Binance webhook. العميل يرسل المبلغ إلى Binance ID ثم ينسخ **Order ID الرقمي فقط**. Transaction ID مرفوض ولا يستخدم كـfallback. السيرفر يستعلم من `GET /sapi/v1/pay/transactions` ويطابق `orderId` والحساب المستلم والعملة والوقت، ثم يمنع إعادة استخدام Order ID ويضيف الرصيد بصورة ذرية. سجل Binance في Admin يُحمّل من الخادم مع Cache وManual Refresh ولا يكشف المفاتيح.

مفاتيح Binance الخاصة لا تظهر في Admin Panel ولا تخزن في `payment_settings`. لا تحتاج صلاحية Withdraw لهذا النظام، ولا يُنصح بتفعيلها.

### Manual USDT (BEP20)

- `USDT_BEP20_ADDRESS`
- `USDT_BEP20_MIN_DEPOSIT`
- `USDT_BEP20_MAX_DEPOSIT`
- `USDT_BEP20_EXPIRY_MINUTES`
- `USDT_BEP20_NETWORK_NAME`
- `DEPOSIT_PRESETS`
- `MIN_DEPOSIT`
- `MAX_DEPOSIT`

عمليات BEP20 الجديدة تدخل `pending_review` بعد إرسال Network TxID صالح يبدأ بـ`0x`. لا يدّعي البوت فحصًا تلقائيًا على السلسلة بدون Provider/RPC حقيقي. سجلات TRC20 القديمة تبقى ظاهرة باسم `Legacy USDT TRC20` فقط.

### توليد Secrets على PowerShell

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[BitConverter]::ToString($bytes).Replace('-','').ToLower()
```

استخدم قيمة مختلفة لكل من `ADMIN_SESSION_SECRET` و`INVENTORY_ENCRYPTION_KEY`. لا تغيّر `INVENTORY_ENCRYPTION_KEY` بعد تخزين Inventory قديم إلا مع خطة re-encryption.

## 3) التشغيل المحلي

المشروع يتطلب **Node.js 22+** لأن dependency lock الحالي (خصوصًا Supabase JS) يتطلب Node 22.

```bash
npm ci
npm run check
npm test
npm start
```

للتطوير المحلي اترك `WEBHOOK_URL=` فارغًا حتى يعمل Telegram polling.

افتح:

- `http://localhost:3000/health`
- `http://localhost:3000/admin`

## 4) Render Deployment

أنشئ **Web Service** واربط GitHub repository.

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

بعد إنشاء الخدمة:

1. أضف Environment Variables من `.env.example`.
2. ضع رابط Render HTTPS نفسه في `WEBHOOK_URL` و`PUBLIC_BASE_URL`.
3. اجعل `TELEGRAM_WEBHOOK_SECRET` قيمة عشوائية قوية.
4. Deploy.
5. افتح `/health` وتأكد من `status: healthy`.
6. افتح `/admin` وسجّل الدخول.

عند وجود `WEBHOOK_URL` يضبط التطبيق Telegram webhook تلقائيًا على:

```text
POST /webhook/telegram
```

لا يوجد Binance webhook في وضع التحقق الجديد؛ التحقق يتم عند إرسال المستخدم Order ID داخل البوت عبر Binance account API.

## 5) إعداد المنتجات

### Instant Product — مثال Gemini Activation Links

من **Admin → Products**:

- `Product Status = Active`
- `Delivery type = Instant — unique inventory`
- Duration مثل `18 Months`
- Product Type مثل `Activation Link`
- Warranty مثل `6 Hours`
- Min/Max Quantity حسب المطلوب
- فعّل Bulk Pricing إذا لزم

ثم افتح Inventory وأدخل:

```text
https://example.com/invite/one
https://example.com/invite/two
https://example.com/invite/three
```

كل سطر = وحدة واحدة. شراء Quantity 3 يحجز/يسلّم 3 عناصر مختلفة. الـstock للـInstant مشتق من عدد العناصر `available` ولا يعتمد على Stock يدوي.

### Manual Product

اختر `Manual / non-instant`. يمكن تحديد Manual Stock أو Unlimited وAllow pre-order. بعد الشراء يظهر الطلب في Manual/Pre-Orders ويحتاج تسليم من الأدمن.

### Bulk Pricing

في حقل Tiers استخدم:

```text
1|19|0.59
20|49|0.50
50|99|0.45
100||0.40
```

الصيغة: `min|max|unit_price`، واترك max فارغًا لآخر tier المفتوح. الحساب الحقيقي يحصل داخل `purchase_product_v2` وليس من الواجهة.

## 6) Bot Links

من **Admin → Bot Links** أضف مفاتيح مثل:

- `support`
- `contact`
- `channel`
- `whatsapp`
- `website`
- `terms`
- أي `custom_*`

كل Link يدعم: Button Text، HTTPS URL، Enable/Disable، Sort Order.

## 7) FAQ

من **Admin → FAQ** أضف السؤال والجواب واللغة (`all/en/ar/hi`) والترتيب والحالة. زر FAQ في Telegram يقرأ البيانات مباشرة من Supabase.

## 8) Chat With Us

من Telegram:

**Support → Chat in Bot** ثم يرسل المستخدم رسالته.

من Admin:

**Support Inbox** يعرض Telegram ID/username/name/status/unread/history وRecent Orders. الرد من لوحة الإدارة يُرسل عبر `bot.telegram.sendMessage()` مباشرة للمستخدم.

## 9) Notifications / Automation

من **Admin → Automation**:

1. افتح Event المطلوب (`New Product`, `Restock`, `Price Drop`, `Selling Fast`, `Out Of Stock`, `Product Update`).
2. فعّل Event وحدد Destination Mode.
3. للقنوات/المجموعات استخدم `@channelusername` أو Chat ID مثل `-100...`.
4. يجب أن يكون البوت Admin/يمتلك صلاحية إرسال الرسائل في القناة أو المجموعة.
5. استخدم **Test** قبل تفعيل الإرسال التلقائي.
6. Selling Fast thresholds تقبل مثل `8, 5, 3`، والـcooldown يمنع التكرار.
7. History تعرض queued/processing/completed/failed/cancelled مع sent/failed/progress.

رسائل Channel/Group تستخدم رابطًا عميقًا آمنًا يفتح المنتج داخل البوت مباشرة. الـBroadcast/Automation لا تستخدم `Promise.all` لإرسال آلاف الرسائل دفعة واحدة.

## 10) Payment Settings

**Admin → Payment Settings** يتحكم فقط في:

- Enabled/Disabled
- Display Name
- Public JSON configuration

الـAPI keys والـsecrets تبقى في Render Environment Variables.

## 10) الأمان

المشروع يحافظ على:

- Signed admin sessions
- CSRF + Same-Origin protection
- Login throttling/rate limiting
- Security headers/CSP
- Server-side validation
- Service-role-only database access من السيرفر
- No client-trusted price/total
- Atomic wallet purchase
- Encrypted unique inventory
- Audit log للعمليات الحساسة
- Backend out-of-stock checks ومنع negative stock

## 11) Verification

نفّذ قبل Production:

```bash
npm run check
npm test
```

تغطي الاختبارات الآلية 60 حالة، ومنها 15 حالة v6.2 للتسليم المتعدد والإيموجيات والتنظيف. ثم اختبر يدويًا على بيئة Supabase/Telegram فعلية:

`/start → Products → Category → Product → Quantity → Checkout → Wallet → Delivery`, ثم FAQ، Support Chat، Admin reply، Inventory، Orders، Settings، Payment switches، وOut-of-stock behavior.

## ملاحظة Migration

لترقية النسخة الحالية استخدم migrations السابقة عند الحاجة ثم شغّل `migration_v6_2_multi_delivery_chat_cleanup.sql` أخيرًا. لا تستبدل قاعدة بياناتك الحالية ولا تحذف الجداول. بعد نجاح الـmigration انشر الكود الجديد، ثم اختبر طلبًا Instant بكمية 5 ومساري Wallet وBinance Pay.
