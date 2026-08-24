# Verification — Production Upgrade v6

## Final v6 result

- `npm ci`: **PASS** — 123 packages installed from the lockfile.
- `npm run check`: **PASS** — all backend, bot, admin and service JavaScript files pass syntax validation.
- Embedded Admin Panel client JavaScript: **PASS** via `new Function()` validation.
- `npm test`: **44/44 PASS**, 0 failed, 0 skipped.
- Added coverage for Order-ID-only Binance matching, rejected Transaction ID fallback, receiver/currency/time checks, BEP20 TxID format, stock-bounded quantity keyboard, v6 migration contracts, Binance Admin history and scheduled sales.
- No real `.env`, API key, bot token, Supabase key or inventory secret is included.

## Historical v5 verification

## Completed checks

- `npm run check`: **PASS** (all active JS files, including `src/services/notifications.js` and admin security).
- Embedded Admin Panel client JavaScript extracted and checked with `node --check`: **PASS**.
- Dependency-free regression/contract suite: **29/29 PASS**.
  - admin security
  - i18n / keyboard behavior
  - project payment contracts
  - upgrade/atomic purchase contracts
  - utility functions
  - v5 catalog / Other Products / persistent keyboard / migration / automation contracts
- No real `.env` file included.
- No `node_modules` is included in the final archive.
- No new v5 Environment Variables are required.

## Full `npm test` note

A full `npm test` was attempted in the build sandbox. The v5 tests and all dependency-free existing tests passed, but three existing suites could not load because the sandbox could not download npm packages (`express` / `dotenv` and transitive dependencies) due registry/DNS errors (`EAI_AGAIN`). This is an environment dependency-install limitation, not a test assertion failure in those suites.

On Render or another network-connected Node.js 22+ environment, run:

```bash
npm ci
npm run check
npm test
```

before production rollout.

## SQL migration compatibility fix

The migration was hardened for existing databases where `product_catalog` / `category_catalog` already have a newer column shape. PostgreSQL does not permit dropping or inserting view columns via `CREATE OR REPLACE VIEW`, so the migration now recreates only those views in dependency-safe order and restores their permissions. No table data is dropped.
