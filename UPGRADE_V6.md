# Telegram Store Bot v6 — Upgrade and Deployment

## Safe database upgrade

1. Back up the current Supabase database.
2. Open Supabase → SQL Editor.
3. If the database has not received the older v5 upgrade, run `migration.sql`, then `migration_binance_uid_auto.sql`.
4. Run `migration_v6_ui_bep20_binance_history.sql` last.
5. Do not replace the current database with `database.sql`; that file is for a fresh installation.

The v6 migration does not drop or truncate users, products, orders, deposits, wallets, inventory, or payment history. It disables TRC20 for new deposits while retaining `usdt_trc20` rows as legacy history.

## New environment variables only

```env
USDT_BEP20_ADDRESS=0xYourReceivingAddress
USDT_BEP20_MIN_DEPOSIT=1
USDT_BEP20_MAX_DEPOSIT=1000
USDT_BEP20_EXPIRY_MINUTES=30
USDT_BEP20_NETWORK_NAME=BNB Smart Chain (BEP20)
```

Public payment values can also be changed under Admin → Payment Settings. Binance and Supabase secrets remain server-side environment variables only.

## Local run

Requires Node.js 22 or newer.

```bash
npm ci
npm run check
npm test
npm start
```

Leave `WEBHOOK_URL` empty locally to use Telegram polling. Open:

- Admin: `http://localhost:3000/admin`
- Health: `http://localhost:3000/health`

## Render deployment

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

Set `WEBHOOK_URL` and `PUBLIC_BASE_URL` to the Render HTTPS service URL, add the variables from `.env.example`, deploy, then verify `/health` and `/admin`.

## v6 feature summary

- Binance verification accepts one numeric `orderId` only. Transaction IDs are rejected and never used as fallback.
- Wallet credit and deposit approval are atomic and protected by a unique Binance Order ID.
- Admin Binance Pay Transactions page supports Order ID, Transaction ID history search, dates, currency, incoming-only, cache, manual refresh and API test.
- New deposits use USDT on BEP20. Submitted Network TxIDs enter `pending_review` for Admin approval/rejection unless a real on-chain provider is added later.
- Product Buy Now opens a large Reply Keyboard. Small stock shows every number from 1 to stock; large stock uses Admin presets and optional Custom Quantity.
- Main Menu enable/disable, one/two-column layout, labels for EN/AR/HI, quantity thresholds/presets/columns and custom emoji IDs are editable in Admin.
- New Product, Restock, Flash Sale/Price Drop, Selling Fast, Out of Stock and Product Update reuse the existing persistent notification queue and direct product links.
- Scheduled Flash Sale changes the price at start, triggers the existing price-drop notification, then restores the original price safely at end.

## Verification

- `npm run check`: PASS
- Embedded Admin client syntax: PASS
- `npm test`: 44 passed, 0 failed
