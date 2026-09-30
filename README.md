# Marketplace — cash-on-delivery storefront on a synced Shopify catalog

A Next.js storefront that sells a Shopify catalog **cash on delivery**, with MySQL as the
storefront's source of truth and a separate worker process owning every Shopify call.

Two rules shape the whole design:

1. **The storefront never calls Shopify.** It reads MySQL. A background worker syncs the
   catalog in, and submits orders out. Catalog freshness is bounded by the sync interval, not by
   whoever happens to load a page.
2. **The browser is never trusted for price, stock, or whether a product may be sold.** The cart
   holds variant ids and quantities and nothing else; every price is re-read from MySQL
   immediately before the order is written.

Status: the product sync, storefront, cart, COD checkout and asynchronous order submission are
implemented and tested, and one real order has been taken end to end on a development store.
Webhooks and an admin UI are not built. Known gaps are listed in
[Known limitations](#known-limitations) and in detail in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Architecture

```
                  ┌──────────────────────── web process (Next.js) ────────────────────────┐
                  │  storefront pages    cart (localStorage)    POST /api/checkout         │
                  │         │                    │                      │                 │
                  │         └──── reads ─────────┴──── reads/writes ─────┘                 │
                  └───────────────────────────────┬──────────────────────────────────────┬─┘
                                                  │                                      │
                                              ┌───▼────┐                            ┌────▼────┐
                                              │ MySQL  │                            │  Redis  │
                                              └───▲────┘                            └────▲────┘
                                                  │                                      │
                  ┌───────────────────────────────┴──────────────────────────────────────┴─┐
                  │                     worker process (BullMQ)                             │
                  │  product-sync ─ product-sync-page ─ variant-sync   submit-order         │
                  │                          │                              │   order-recovery
                  └──────────────────────────┼──────────────────────────────┼──────────────┘
                                             │                              │
                                       ┌─────▼──────────────────────────────▼─────┐
                                       │        Shopify Admin GraphQL API         │
                                       └──────────────────────────────────────────┘
```

The web process is a **producer only**: it may call `queue.add`, and never constructs a BullMQ
`Worker`. The worker serves no HTTP. That separation is why a catalog sync can take minutes
without holding a request open, and why a Shopify outage cannot take the storefront down.

`ARCHITECTURE.md` is the authoritative design document: process topology (§2), the product flow
(§3), the storefront (§3a), the order flow (§4), data ownership (§5), queues (§6), retry
boundaries (§7), the database constraints Prisma cannot express (§7a), cross-cutting rules (§8)
and risks (§9).

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Web | Next.js 16 (App Router, Turbopack), React 19 | Server Components by default; five client components and one client hook in total |
| Language | TypeScript (strict) | |
| Database | MySQL 8.4 via Prisma 6 | `DECIMAL(18,4)` money; hand-written CHECK constraints |
| Queue | BullMQ 6 on Redis 7 | ID-only job payloads |
| Shopify | Admin GraphQL, API version pinned by env | Node `fetch`, no SDK |
| Validation | zod 4 | `.strict()` schemas |
| Logging | pino 10 | structured JSON, synchronous destination, redaction |
| UI | AdminLTE 3.2 (vendored CSS) + Bootstrap 4.6 | no jQuery |
| Tests | Vitest 5 | unit suite + integration suite against real MySQL and Redis |

## Prerequisites

- **Node.js 24** (developed on 24.19; the code uses `node --env-file-if-exists` and native
  `fetch`)
- **Docker Desktop** — MySQL and Redis run in containers
- A **Shopify development store** and a custom app in the same organisation (only needed to sync
  a catalog or submit an order; the storefront and all tests run without Shopify)

## Environment setup

```bash
git clone <repo> && cd marketplace
npm install
cp .env.example .env     # then fill it in
```

`.env` is gitignored and must stay that way. `.env.example` documents every variable with the
reasoning behind its default; the values there are placeholders (`REPLACE_ME`), never
credentials.

Minimum to run the storefront and the tests:

| Variable | Purpose |
|---|---|
| `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_SHADOW_DATABASE`, `MYSQL_TEST_DATABASE` | consumed by `docker-compose.yml` and its init script |
| `DATABASE_URL` | app connection, with an explicit `connection_limit` |
| `SHADOW_DATABASE_URL` | Prisma migrations |
| `TEST_DATABASE_URL` | integration tests; the database name **must** end in `_test` |
| `REDIS_URL` | BullMQ |

Additionally for Shopify: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_API_VERSION`.

Optional tuning (all have production-appropriate defaults): `SHOPIFY_PRODUCTS_PER_PAGE`,
`SHOPIFY_VARIANTS_PER_PAGE`, `PRODUCT_SYNC_INTERVAL_MINUTES`, `SYNC_HEARTBEAT_STALE_SECONDS`,
`SYNC_SCHEDULERS_ENABLED`, `ORDER_CLAIM_LEASE_SECONDS`, `ORDER_RECOVERY_GRACE_SECONDS`,
`ORDER_RECOVERY_INTERVAL_MINUTES`, `ORDER_RECOVERY_ENABLED`, `SHOPIFY_COD_PAYMENT_MODE`,
`LOG_LEVEL`.

## Docker, MySQL and Redis

```bash
docker compose up -d
docker compose ps          # both services should report (healthy)
```

- **MySQL 8.4** on host port `3307` by default (`MYSQL_HOST_PORT`), `utf8mb4` /
  `utf8mb4_unicode_ci`. Port 3307 rather than 3306 so it cannot collide with a local MySQL.
  Note 8.4 removed `--skip-character-set-client-handshake`; the charset is set with
  `--character-set-server` / `--collation-server` instead.
- **Redis 7** on host port `6379` (`REDIS_HOST_PORT`), with persistence enabled so a restart
  does not silently drop queued work.
- `docker/mysql/init/01-databases-and-grants.sh` creates the application user, the app database,
  the shadow database used by Prisma migrations, and the `_test` database used by the integration
  suite, granting the app user privileges scoped to those three schemas and nothing server-wide.

### If you already have a MySQL volume

MySQL runs `/docker-entrypoint-initdb.d` scripts **only on first initialisation — that is, when
the data directory is empty.** If a MySQL volume already exists, *regardless of when it was
created*, the init script **will not run again**, and `docker compose up -d` will not create any
database the volume is missing.

So on an existing volume, create the shadow and test databases once, by hand:

```sql
CREATE DATABASE IF NOT EXISTS marketplace_shadow
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS marketplace_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON marketplace_shadow.* TO 'marketplace_app'@'%';
GRANT ALL PRIVILEGES ON marketplace_test.*   TO 'marketplace_app'@'%';
FLUSH PRIVILEGES;
```

Adjust the names if you changed `MYSQL_SHADOW_DATABASE`, `MYSQL_TEST_DATABASE` or `MYSQL_USER`.
Run it as `root` inside the container:

```bash
docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'
```

The alternative is to discard the volume and let the script run on a fresh one, which destroys
every local database:

```bash
docker compose down -v      # deletes mysql-data and redis-data
docker compose up -d
```

## Prisma migrations

```bash
npx prisma migrate deploy   # apply pending migrations
npx prisma generate         # regenerate the client (output: src/generated/prisma, gitignored)
npx prisma migrate status   # confirm the database matches the migration history
```

Three migrations, applied in order:

| Migration | What it does |
|---|---|
| `20260929053009_init` | all tables, plus hand-written `CHECK` constraints and the collation fix |
| `20260929142458_job_log_status_transitions` | `JobLog.startStatus`, `endStatus`, `retryable` |
| `20260929172148_job_log_instance_discriminator` | `JobLog.jobInstance`, and the uniqueness swap that goes with it |

The init migration is **not** purely generated: the `CHECK` constraints at the end were written
by hand because Prisma cannot express them. See [docs/DATABASE.md](docs/DATABASE.md).

## Shopify app setup and scopes

The app authenticates with the **client credentials grant** — it exchanges its own id and secret
for a short-lived Admin API token with no merchant interaction, which is the right shape for a
server-side integration acting on its own store. The app and the store must be in the same
Shopify organisation, and the app must be installed through its **Custom distribution** link.

Declare these access scopes on the app version:

| Scope | Needed for |
|---|---|
| `read_products` | catalog sync |
| `read_inventory` | `inventoryQuantity` / `tracked`, for the checkout stock check |
| `write_draft_orders` | `draftOrderCreate`, `draftOrderComplete` |
| `read_draft_orders` | the submission's two recovery lookups (granted implicitly with the write scope, documented explicitly because relying on that is not obvious) |
| `read_orders` | `DraftOrder.order` is gated; without it the worker cannot read back the order id it must persist |

**Protected customer data (Level 2)** — name, address, phone, email — is required, because a COD
parcel cannot be delivered without them. Shopify documents Level 2 as always available to a
custom app with no review on a development store, but it has to be enabled: before this app was
reinstalled through its Custom distribution link, Shopify refused to return the
`CalculatedDraftOrder` object at all.

Verify authentication without touching data:

```bash
npm run verify:shopify
```

## Product sync flow

```
trigger ──> product-sync ──> product-sync-page ──chain──> product-sync-page ──> …
                                   │                              │
                                   └── variant-sync (only for >100-variant products)
```

- **Triggers**: a 15-minute incremental schedule, a nightly full reconciliation (03:00), and
  `POST /api/admin/sync` for a manual run. Every trigger does the same thing — enqueue and
  return.
- **Chained page jobs** with keyset cursors, never `OFFSET`, so a crash loses one page rather
  than the run. Page size defaults to 50 products × 100 variants.
- **One run at a time**, enforced by a `UNIQUE` column in MySQL rather than by a Redis lock, with
  heartbeat-based reclaim for a holder that died.
- **Upserts keyed on Shopify ids**, guarded by `shopifyUpdatedAt`, with `P2002` races resolved
  into updates instead of failing the page.
- **Soft deactivation only.** Products missing from a complete full sync are marked inactive by
  set difference; nothing is hard-deleted. A run reaches `COMPLETED` only when every page
  succeeded — a page that exhausts its attempts ends the run `PARTIAL`.
- `variantSyncComplete` flips to true only when Shopify reports no further variant pages, so a
  truncated variant set is never presented as complete.

## Storefront, cart and checkout flow

**Storefront** (`/`, `/products/[handle]`) reads MySQL through one `server-only` service. Prices
are `Decimal` in the database and exact decimal **strings** everywhere after that; no amount
becomes a JavaScript number. No internal column (`lastSyncRunId`, `syncedAt`,
`variantSyncCursor`, anything from `SyncRun` or `JobLog`) is ever selected into a response. A
handle from the URL selects a row but never decides whether it may be shown, so inactive,
archived and unknown all share one 404 path.

**Cart** (`/cart`) is `localStorage` holding exactly `{ variantId, quantity }`. No price, not
even as a cache — a cached price is a second answer to "what does this cost", and the wrong one
would be the one the customer saw. `POST /api/cart/hydrate` turns those ids into current titles,
images, prices and availability from MySQL. A line the catalog can no longer sell is shown and
marked rather than silently dropped, and it blocks checkout.

**Checkout** (`/checkout` → `POST /api/checkout`):

1. strict zod validation — the schema has **no money field at all**, so a browser sending
   `price` gets a 400 rather than a silently ignored key
2. idempotency lookup, compared against a `requestFingerprint` **before** anything is returned
3. every variant re-read from MySQL: active variant, active product, stock re-checked
4. totals computed here with `Decimal`; shipping 0, tax 0, `grandTotal = subtotal`
5. one transaction writes `Order` (`PENDING_SYNC`) plus `OrderItem` price snapshots
6. **after** the commit, exactly one `submit-order` job is enqueued
7. the reference and a confirmation URL are returned — Shopify is never called here

The confirmation page (`/orders/[publicToken]`) is addressed by an unguessable 32-byte token,
never by the customer-facing reference, and shows no phone, email or street address.

## Asynchronous COD order flow

```
PENDING_SYNC ──claim──> SYNCING ──draftOrderCreate + persist id──> DRAFT_CREATED
                           │                                            │
                           │                                  ┌──claim──┘
                           │                                  ▼
                           │                               SYNCING ──draftOrderComplete──> SYNCED
                           └────── permanent, or attempts exhausted ──────> FAILED
```

- Every transition is a **conditional `updateMany`** carrying the expected state in its `WHERE`
  clause. Two workers may both read `PENDING_SYNC`, but only one `UPDATE … WHERE status =
  'PENDING_SYNC'` affects a row; the loser stands down.
- The claim is a **lease**, not a latch: a `SYNCING` row older than `ORDER_CLAIM_LEASE_SECONDS`
  belonged to a worker that died and is reclaimable.
- The draft id is persisted **before** completion is attempted. That checkpoint plus a tag
  pre-flight (`tag:"cod-<key>"`) means a lost `draftOrderCreate` response never produces a second
  draft, and an exact `draftOrder(id:)` lookup means a lost `draftOrderComplete` response adopts
  the order it already created.
- **Retryable** (transport, 429, 5xx, anything unrecognised) releases the claim and rethrows so
  BullMQ retries. **Permanent** (mutation `userErrors`, GraphQL or auth errors) marks `FAILED`
  immediately and **keeps** the draft id, so an operator retry resumes instead of duplicating.
- The `Order` row **is** the outbox. An `order-recovery` sweep re-enqueues `PENDING_SYNC` and
  `DRAFT_CREATED` orders past a grace period and `SYNCING` orders past the lease, so a failed
  enqueue does not lose a customer's order.
- COD is currently expressed as `draftOrderComplete(paymentPending: true)` — see
  [Known limitations](#known-limitations).

## Worker commands

```bash
npm run worker        # the worker process
npm run worker:dev    # the same, with --watch
```

The worker registers the queues, the 15-minute and nightly sync schedules and the order recovery
sweep, then runs until `SIGTERM`/`SIGINT`, closing queues gracefully so a deploy does not leave a
half-written page. Concurrency: `product-sync` 1, `product-sync-page` 3, `variant-sync` 3,
`submit-order` 1, `order-recovery` 1.

Trigger a sync by hand:

```bash
curl -X POST localhost:3000/api/admin/sync -H 'content-type: application/json' -d '{"mode":"FULL"}'
```

## Test commands

```bash
npm test                  # unit: pure logic, fixtures, fake clients. No services needed
npm run test:integration  # integration: real MySQL + real Redis (requires docker compose up)
npm run typecheck
npm run lint
npm run build
```

The integration harness **refuses to start** unless `TEST_DATABASE_URL` names a database ending
in `_test`, because those tests truncate every table. Counts and evidence:
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Known limitations

Honest list; the full set with reasoning lives in `ARCHITECTURE.md` (§3.7, §3a.1, §4.1c, §4.2c).

**Correctness**

- **No inventory reservation (C1).** Stock is re-read and validated server-side at checkout but
  never reserved, so two simultaneous checkouts for the last unit can both succeed. This is the
  largest known gap and it is deliberate: a half-built reservation counter that silently drifts
  is worse than a documented race. It also means `inventoryQuantity` is a snapshot up to one sync
  interval stale.
- **COD relies on a deprecated argument (D10).** `draftOrderComplete(paymentPending: true)` is
  the default because `paymentTerms` — the documented replacement — is refused for this app
  ("The user must have access to set payment terms"). Both mechanisms are implemented; migrating
  is one setting, `SHOPIFY_COD_PAYMENT_MODE=payment_terms`, once the permission exists.
- **`draftOrderComplete` is not idempotent by contract (D9).** Safety comes from the lookup
  before it, which is read-then-act with a small window; `UNIQUE(shopifyOrderId)` is the backstop.
- **BullMQ's stall timer (120s) is shorter than the database lease (300s) (D8).** A dead worker's
  order therefore waits for the recovery sweep rather than the next re-delivery. Bounded and
  self-healing; never a duplicate.

**Not built**

- **No webhooks.** The 15-minute incremental sync *is* the freshness guarantee.
- **No admin UI (D4).** A `FAILED` order sits in MySQL with `failureReason` and `lastError` and
  nothing surfaces it; the recovery sweep deliberately does not retry `FAILED`.
- **No sweep for stranded drafts (D5).** An order that reached `DRAFT_CREATED` then failed
  permanently leaves a real draft in Shopify. Drafts are inert, but they accumulate.
- **No rate limit on `POST /api/checkout` (C4)**, and **no retention or erasure policy for order
  PII (C5)**.
- **No UI component tests (C6).** There is no DOM test harness in the project; the rules worth
  protecting live in pure modules and services, which are tested directly.

**Scale and environment**

- **Shopify cost pacing is process-local (S2).** Two worker processes would each pace against
  their own partial view of a per-shop budget. Running more than one needs a shared limiter, not
  a larger concurrency number.
- **Nested variant pagination has never run against live data (S8).** No product in the store comes
  close to 100 variants — 5 at most in the archived seed catalog, 2 in the current one — so the
  >100-variant chain is covered by automated tests only.
- **Keyset pagination beyond page 1 was exercised with a reduced page size (F5)**, not with a
  catalog large enough to need it — the current 10-product catalog fits one 24-card page.
- **Publication state is not synced (F6).** A product that is `ACTIVE` in Shopify but unpublished
  from the Online Store channel is still listed here. Documented as a scope decision rather than
  patched with a storefront filter that would disagree with the data it reads. The seed product that
  used to demonstrate this has been archived, so no live product shows it today — the gap itself is
  unchanged.
- `next/image` is bypassed (F2) and AdminLTE is vendored rather than installed (F3), both for
  reasons recorded in `ARCHITECTURE.md`.

## Security decisions

- **Secrets never reach the repository.** `.env` is gitignored (`.env*`); `.env.example` holds
  placeholders only. The Shopify access token exists as a local variable and one request header —
  never logged, never in a URL, never attached to an error. The granted scope string *is* logged,
  because it is not secret and is what explains a later 403.
- **The browser is not trusted.** The checkout schema is `.strict()` and contains no money field,
  so a client-supplied price is not rejected so much as unrepresentable. Prices, stock and
  sellability are re-read from MySQL immediately before the write.
- **PII is minimised and never logged.** Structured logs carry an order id, an item count, a
  status transition and a duration. `REDACT_PATHS` in `src/lib/logger.ts` is the backstop for the
  day someone logs a whole `Order` row, and covers city, province and postal code as well as the
  obvious fields — a city plus a postal code plus a name identifies a household. Job payloads
  carry ids only, so Redis never holds customer data.
- **Order URLs are unguessable.** The confirmation page is addressed by a 32-byte random token,
  not by the short reference that gets spoken aloud during support calls, so the order table
  cannot be enumerated. An unknown token and someone else's token are the same 404.
- **`server-only` is a build-time boundary.** Importing a catalog or cart service from a client
  component fails the build rather than shipping Prisma, the connection string and every internal
  column to a browser.
- **The database enforces what it can.** Hand-written `CHECK` constraints assert that a line
  total equals unit price × quantity and that a grand total equals its parts, so a bug in
  application code cannot persist incoherent money. Unique indexes — `idempotencyKey`,
  `submissionKey`, `shopifyDraftOrderId`, `shopifyOrderId` — are the final duplicate protection,
  not the BullMQ job id.
- **Money is never a float.** `DECIMAL(18,4)` in MySQL, `Prisma.Decimal` in arithmetic, exact
  strings on the wire.

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | the authoritative design, decisions and every known gap |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | what was tested and how, including the live order |
| [docs/SUBMISSION.md](docs/SUBMISSION.md) | reviewer's guide: what to look at and where |
| [docs/DATABASE.md](docs/DATABASE.md) | schema, indexes and the constraints Prisma cannot express |
