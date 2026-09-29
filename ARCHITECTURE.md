# Architecture — COD Marketplace on Shopify

Status: **Phase 1 — decisions locked; schema, initial migration and local infrastructure
applied.** MySQL 8.4 and Redis 7 run from `docker-compose.yml`, migration `20260929053009_init`
is applied, and Prisma Client generates. No Shopify calls, no workers, no UI, no checkout
implementation yet.

---

## 1. Context and constraints

| Area | Decision |
|---|---|
| Web framework | Next.js **16.3.6** App Router + TypeScript (Turbopack default, async request APIs, `proxy.ts` not `middleware.ts`) |
| Database | MySQL, accessed **only** through Prisma |
| Queue | Redis + BullMQ |
| Catalog source | Shopify Admin **GraphQL** API, version **pinned in configuration** (`SHOPIFY_API_VERSION`) |
| Shopify app | Single **development store**, custom app with an Admin API access token — **no OAuth install flow** |
| Admin UI | AdminLTE v3.2.0 (static assets in `public/adminlte`) |
| Payment | **Cash on Delivery only** — no gateway, no card data, no PCI scope |
| Order creation | `draftOrderCreate` → `draftOrderComplete(paymentPending: true)` |
| Tax / shipping | **Out of scope** — both fixed at `0`. Local subtotal is authoritative |
| Inventory | Server-side re-check at checkout; **no reservation system** (see §4.1 and §9.6) |
| Currency | **Single currency** — the store's configured currency, stored on every order |
| Checkout | **Guest only** — no customer accounts, no OTP |
| Sync cadence | Repeatable job every **10–15 minutes** |
| Webhooks | **Bonus** — must not block core implementation |
| Package manager | **npm only** |

Hard architectural rules (non-negotiable):

1. The storefront **never** calls Shopify. Not on render, not on an API route, not on a fallback path.
2. Shopify is the **source of truth for catalog**. MySQL is a read replica of it, maintained by a worker.
3. The storefront reads products **only** from MySQL via Prisma.
4. Checkout writes the order to MySQL **first**, then enqueues a job.
5. A **separate OS process** (not Next.js) creates the order in Shopify.
6. No long Shopify operation ever runs inside a user request.

---

## 2. Process topology

```
┌──────────────────┐        ┌──────────────────┐
│  next (web)      │        │  worker          │
│  - storefront    │        │  - product sync  │
│  - AdminLTE      │        │  - variant sync  │
│  - route handlers│        │  - submit order  │
│  - server actions│        │  - reconcile     │
└────────┬─────────┘        └───┬──────────┬───┘
         │  Prisma               │ Prisma   │ HTTPS
         ▼                       ▼          ▼
     ┌────────┐             ┌────────┐  ┌──────────────┐
     │ MySQL  │◄────────────┤ MySQL  │  │ Shopify Admin│
     └────────┘             └────────┘  │   GraphQL    │
         ▲                       ▲      └──────────────┘
         │ enqueue only          │ consume
         └────────┐     ┌────────┘
                  ▼     ▼
                ┌─────────┐
                │  Redis  │  (BullMQ)
                └─────────┘
```

The web process is a **producer only** — it may call `queue.add()`, never construct a BullMQ
`Worker`. The worker is a **consumer only**, serving no HTTP except an optional `/healthz`.

Shared code lives in `src/lib`. `src/app` / `src/server` ↔ `src/worker` is a forbidden import edge,
to be enforced by an ESLint boundary rule.

---

## 3. Product flow — Shopify → worker → MySQL → storefront

### 3.1 Triggers

| Trigger | Mechanism | Purpose | Scope |
|---|---|---|---|
| Scheduled | BullMQ repeatable job, every 10–15 min | incremental catch-up | core |
| Nightly | BullMQ repeatable job | full reconciliation sweep | core |
| Manual | AdminLTE button → `POST /api/admin/sync` → `queue.add()` | operator-forced resync | core |
| Webhook | `POST /api/webhooks/shopify` → HMAC verify → `queue.add()` | near-real-time updates | **bonus** |

Every trigger does the same thing: **enqueue and return**. Because webhooks are bonus scope, the
10–15 minute incremental run is the **only** guaranteed freshness mechanism, and catalog staleness
is bounded by it.

### 3.2 The sync run (chained cursor pagination)

```
product-sync  (orchestrator, concurrency 1)
  │  creates SyncRun (mode, watermark, status=RUNNING, activeLock='ACTIVE', heartbeatAt=now)
  │  enqueues the first page job with cursor = null
  ▼
product-sync-page  { syncRunId, cursor, pageIndex }
  │  0. refresh SyncRun.heartbeatAt
  │  1. products(first: N, after: $cursor, query: "updated_at:>=$watermark")
  │        requesting variants(first: 100) inline
  │  2. upsert each product + its inline variants
  │  3. for any product where variants.pageInfo.hasNextPage
  │         → set variantSyncComplete = false, variantSyncCursor = endCursor
  │         → enqueue variant-sync { productGid, cursor }
  │  4. if products.pageInfo.hasNextPage
  │         → enqueue product-sync-page { cursor: endCursor, pageIndex + 1 }
  │      else
  │         → finalize (reconcile + deactivate, status=COMPLETED, activeLock=NULL)
  ▼
variant-sync  { productGid, cursor }
       productVariants page → upsert → re-enqueue self while hasNextPage
       on exhaustion → variantSyncComplete = true, variantSyncCursor = null
```

A single job walking 400 pages holds a BullMQ lock for minutes, dies on deploy, and its retry
restarts from page 0. Chained page jobs lose **one page** to a crash.

### 3.3 Variant pagination

- `variants(first: 100)` **inline** with the product covers the overwhelming majority — zero extra
  round trips.
- Only `variants.pageInfo.hasNextPage` spawns a dedicated `variant-sync` chain.
- Never nest `products(250) × variants(250)`: calculated cost is multiplicative and gets throttled.
  Start at `products: 50, variants: 100`, tune from `extensions.cost`.
- `Product.variantSyncComplete` is false for the whole duration of a chain, and stays false if the
  chain fails. **A product with `variantSyncComplete = false` holds a truncated variant set** and
  must not be presented as complete by the storefront.

### 3.4 Product scope and write strategy

**Scope:** all catalog products are synced. The storefront shows only `status = ACTIVE` **and**
`isActive = true`. No sales-channel publication filtering.

- Upsert keyed on `shopifyProductId` / `shopifyVariantId`.
- **`Prisma.upsert` is not atomic on MySQL** — it may emit SELECT-then-write rather than
  `INSERT ... ON DUPLICATE KEY UPDATE`. Concurrent page jobs racing the same new product will
  collide on `P2002`. Every catalog upsert must catch `P2002` and retry as an update, or use raw
  `INSERT ... ON DUPLICATE KEY UPDATE`. The unique constraints make the race *safe*, not *invisible*.
- Apply a write only if `incoming.updatedAt >= stored.shopifyUpdatedAt` — the guard that stops an
  in-flight bulk page from clobbering a newer webhook update.
- Stamp every touched row with `lastSyncRunId`.
- Products absent from a **completed FULL** run are **deactivated** (`isActive = false`,
  `deactivatedAt`, `deactivationReason = MISSING_FROM_SYNC`), never hard-deleted. Incremental runs
  never deactivate.
- Images are reconciled per product: upsert by `shopifyImageId`, then delete that product's images
  absent from the payload.

### 3.5 Storefront read path

```
Server Component → src/server/services/catalog.ts → Prisma → MySQL
```

Keyset pagination (`WHERE (sortKey, id) > (?, ?) ORDER BY sortKey, id LIMIT n`), never `OFFSET`.

Catalog reads use `use cache` + `cacheLife`. The sync worker is a different process and **cannot**
call `revalidateTag` — that API exists only inside the Next runtime. Invalidation is time-based by
default, with an optional authenticated internal revalidate endpoint. Cache lifetime must be ≤ the
sync interval or it compounds staleness.

---

## 4. Order flow — storefront → MySQL → BullMQ → worker → Shopify

### 4.1 Checkout request (synchronous part)

`POST /api/checkout`, or a Server Action with the same body:

1. **Validate** with a strict zod schema (unknown keys rejected). The cart is **client-held** and
   carries `{ variantId, quantity }` only — there is no server-side Cart table, so there is nothing
   stale to trust.
2. **Idempotency check.** Look up `idempotencyKey`. If a row exists, return it **only when
   `requestFingerprint` matches**; otherwise respond `409`. See §4.3.
3. **Re-price server-side.** Prices and currency are read from MySQL. Price fields from the client
   are not validated — they must not exist in the schema at all.
4. **Re-check inventory server-side**, immediately before the write: every line must satisfy
   `quantity <= inventoryQuantity`, or the variant must be untracked, or have
   `inventoryPolicy = CONTINUE`. Insufficient stock rejects the checkout naming the offending lines.
5. Verify each variant is active and its product is active.
6. Totals: `shippingTotal = 0`, `taxTotal = 0`, `grandTotal = subtotal`.
7. In **one Prisma transaction**: insert `Order` (`status = PENDING_SYNC`, `paymentMethod = COD`,
   `currencyCode`, `idempotencyKey`, `requestFingerprint`, `submissionKey`, `publicToken`,
   `reference`) + `OrderItem` rows carrying **price snapshots**.
8. **After commit**, `submitOrderQueue.add({ orderId }, { jobId: order.id })`.
9. Return the reference + confirmation URL. **Never** wait for Shopify.

**There is no outbox table.** The `Order` row *is* the outbox: `status = PENDING_SYNC` means "needs
submitting". If step 8 fails because Redis is down, the request still succeeds and the reconcile
sweeper re-enqueues any `PENDING_SYNC` order older than a grace interval. A separate outbox table
would be 1:1 with the order, carry one event type, and add a whole class of
"outbox says SENT / order says PENDING" divergence for nothing.

#### Known production gap — concurrent-checkout oversell

Inventory is **re-read and validated server-side**, but **not reserved**. Two consequences, both
accepted for this exercise and stated rather than hidden:

- **Concurrent checkouts race.** Two requests for the last unit can both read `inventoryQuantity = 1`,
  both pass validation, and both commit. The check is *read-then-act* with no lock, so it narrows the
  window — it does not close it.
- **The snapshot is stale.** `inventoryQuantity` reflects the last sync and can be up to one sync
  interval (10–15 min) out of date, plus drift from sales made through other channels. A customer can
  order an item Shopify already considers sold out.

Either way `draftOrderComplete` may fail or produce an unfulfillable order. Such orders land in
`FAILED` and surface in AdminLTE for the operator.

**A production implementation would introduce transactional per-order inventory reservations**: a
reservation written in the same transaction as the order, claimed by a guarded conditional update so
concurrent checkouts serialize on the row, released on terminal failure or cancellation, reclaimed
after worker crashes via a lease, reconciled against Shopify inventory after successful submission,
and explicitly excluded from what the periodic catalog sync is allowed to overwrite. That is a
complete subsystem with its own lifecycle and its own reconciliation job — deliberately out of scope
here, because a half-built reservation counter that silently drifts is worse than an honest
documented race.

### 4.2 Submission job — two-phase draft order

```
submit-order processor
 1. CLAIM  updateMany(
             where: { id, OR: [ { status: IN (PENDING_SYNC, DRAFT_CREATED, FAILED) },
                                { status: SYNCING, claimedAt: { lt: now - LEASE } } ] },
             data:  { status: SYNCING, attempt: { increment: 1 }, claimedAt: now })
           count === 0  →  someone else holds a live claim, or it is already SYNCED  →  return OK
 2. if shopifyOrderId is set  →  status = SYNCED, return OK

 ── Phase 1: ensure exactly one draft exists ──────────────────────────────
 3. if shopifyDraftOrderId is null:
      pre-flight  draftOrders(query: "tag:cod-<submissionKey>")  →  found: persist its id
 4. if still null:
      draftOrderCreate(
        tags: ["cod-<submissionKey>", "COD"],
        customAttributes: [{ key: "submissionKey", value: <submissionKey> }],
        note: "Cash on Delivery",
        lineItems: explicit prices from OrderItem snapshots,
        shippingLine: price 0, taxExempt: true )
      →  persist shopifyDraftOrderId IMMEDIATELY, status = DRAFT_CREATED   ← durable checkpoint

 ── Phase 2: complete it ──────────────────────────────────────────────────
 5. read draftOrder(id: shopifyDraftOrderId)
      if draftOrder.order.id is present  →  already completed, take it  (lost-response recovery)
 6. else draftOrderComplete(id: shopifyDraftOrderId, paymentPending: true)
 7. persist shopifyOrderId + shopifyOrderName, status = SYNCED, submittedAt = now
```

The **claim is a lease, not a latch.** Including expired `SYNCING` rows in the claim set is what
makes a crashed worker recoverable; without it an order stranded in `SYNCING` is unreachable by any
retry, forever.

**Phase 2 is keyed by a locally-stored draft ID, not a tag search.** Once `shopifyDraftOrderId` is
persisted, "did this already become an order?" is an exact lookup by ID — strictly stronger than
querying by tag. And **a stranded draft is garbage, not a duplicate order**: drafts are inert, do not
decrement inventory, and are swept by reconciliation. The expensive failure mode lives in the cheap
phase.

Line prices are sent **explicitly** from local snapshots. The exact field names for explicit pricing,
`taxExempt` and the zero shipping line must be confirmed against the pinned API version.

### 4.3 Idempotency

| Layer | Stops | Mechanism |
|---|---|---|
| Client → API | double-click, retry, refresh | unique `idempotencyKey` **+ `requestFingerprint` match** |
| API → queue | sweeper racing the normal enqueue | `jobId = order.id` |
| Queue → DB | stalled re-delivery, two workers, crashed worker | conditional claim with lease |
| Worker → draft | lost response after `draftOrderCreate` | `cod-<submissionKey>` tag pre-flight + unique `shopifyDraftOrderId` |
| Worker → order | lost response after `draftOrderComplete` | exact `draftOrder.order` lookup + unique `shopifyOrderId` |

**`requestFingerprint` is a security control, not a convenience.** An idempotency key is
browser-supplied. Dereferencing one without proving the caller authored the original request would
let a collision — accidental or deliberate — return another customer's order, PII included. The
fingerprint (SHA-256 of normalized cart lines + contact details) binds the key to its request.

**BullMQ dedupe is layer zero.** Every actual guarantee is a MySQL unique index or a conditional
`UPDATE`. Wipe Redis and re-enqueue every order from cold: nothing duplicates.

---

## 5. Source of truth / data ownership

| Data | Owner | Who writes it | Who reads it |
|---|---|---|---|
| Products, variants, images, prices, `inventoryQuantity` | **Shopify** | sync worker only — never the web app, never an admin form | storefront + admin, from MySQL |
| Carts | **Client** (cookie / local storage) | browser | re-validated server-side, never trusted |
| Orders (pre-submission) | **MySQL** | web (create), worker (status transitions) | both |
| Orders (post-submission: fulfilment, payment state) | **Shopify** | Shopify | mirrored back by webhook/sync (bonus) |
| Sync runs, job history, webhook receipts | **MySQL** | worker | admin |
| Queue state | **Redis** | BullMQ | BullMQ + admin dashboards |

With reservations out of scope, the catalog tables are **wholly Shopify-owned** — no column is
co-written by the application. That is a meaningfully simpler ownership story than the reservation
design, and it is the main compensation for the oversell gap.

Consequence: **no admin screen may edit a product field.** An edit would be overwritten by the next
sync and is therefore a lie to the operator.

Redis is **not** a source of truth. Losing it loses in-flight scheduling, not data.

---

## 6. Queues and responsibilities

| Queue | Payload | Concurrency | Attempts | Backoff | Notes |
|---|---|---|---|---|---|
| `product-sync` | `{ mode, syncRunId }` | 1 | 3 | exponential, 30 s | orchestrator; one active run enforced |
| `product-sync-page` | `{ syncRunId, cursor, pageIndex }` | 2–4 | 5 | exponential, 5 s + jitter | refreshes the heartbeat |
| `variant-sync` | `{ productGid, cursor }` | 2–4 | 5 | exponential, 5 s + jitter | only for >100-variant products |
| `submit-order` | `{ orderId }` | 5–10 | 8 | exponential, 10 s → 15 m cap | `jobId = orderId` |
| `reconcile` | `{}` | 1 | 3 | exponential | re-enqueues stale `PENDING_SYNC`, reclaims expired `SYNCING` leases and stale sync locks, lists stranded drafts |

- **Payloads carry IDs, never data.** Redis is plaintext with no retention policy.
- `removeOnComplete` / `removeOnFail` age + count caps.
- Shopify-touching queues share a **global rate limiter** — Shopify's cost bucket is per shop, not
  per worker.
- `lockDuration` must exceed p99 job duration.
- Every processor writes a `JobLog` row at start and updates it at finish. BullMQ's own retention is
  capped and lives in Redis, which this architecture treats as disposable — job history that vanishes
  on a Redis flush is not job history.

---

## 7. Retries and failure boundaries

| Class | Examples | Handling |
|---|---|---|
| **Transient** | network reset, 5xx, Redis blip, MySQL deadlock, `P2002` upsert race | retry, exponential backoff + jitter |
| **Throttled** | GraphQL `THROTTLED`, HTTP 429 | read `extensions.cost.throttleStatus`, sleep until the bucket restores, retry |
| **Terminal-data** | `userErrors` — invalid address, variant not found, out of stock at Shopify | **no retry**; order → `FAILED` with reason; surfaced in AdminLTE |
| **Terminal-auth** | 401/403, missing scope, revoked token | no retry; alert loudly — the integration is down, not one job |
| **Poison** | attempts exhausted | job stays in the failed set (the DLQ); order stays `FAILED`; operator retry enqueues a fresh job |

- A failing **page job** fails one page, not the run → `SyncRun` marked `PARTIAL`, gap closed by the
  next full run.
- A failure **between phase 1 and phase 2** leaves a durable `DRAFT_CREATED` checkpoint; the retry
  resumes at phase 2 and never re-creates the draft.
- A **crashed worker** is recovered by lease expiry — orders via `claimedAt`, sync runs via
  `heartbeatAt`. Neither is self-healing without the reconcile job.
- A **Shopify outage** degrades to: storefront up, checkout up, orders queue and drain on recovery.
- A **Redis outage** degrades to: storefront up, checkout up (the sweeper catches up), no background
  progress.
- A **MySQL outage** is a hard outage. Accepted.

---

## 7a. Database constraints Prisma cannot express

Some invariants are enforced by MySQL but are invisible to Prisma. They live in the
hand-written block at the end of `prisma/migrations/20260929053009_init/migration.sql`,
and are documented in full in the header of `prisma/schema.prisma`.

**Where they live.** In migration SQL, appended below Prisma's generated statements. They
are applied by `prisma migrate deploy` like any other statement, so every environment that
runs the migrations gets them.

**`prisma db pull` cannot reproduce them.** PSL has no syntax for a CHECK constraint or a
database-level collation, so introspecting the database into a schema drops them silently.
Two consequences worth internalising:

- `prisma migrate diff` reports **no drift** for them — Prisma does not see them, so it
  neither reverts nor re-creates them. That is why this works at all.
- If `schema.prisma` is ever regenerated from the database, the constraints stay in MySQL
  but every trace of them disappears from the repository. Re-read the schema header before
  doing that.

**What is enforced in the database** (MySQL 8.0.16+ enforces CHECKs; this project runs 8.4):

| Table | Constraint | Guarantees |
| --- | --- | --- |
| `order_items` | `chk_oi_qty_positive` | `quantity > 0` |
| `order_items` | `chk_oi_unit_price_nonneg` | `unitPrice >= 0` |
| `order_items` | `chk_oi_line_total` | `lineTotal = unitPrice * quantity` — exact, both operands are DECIMAL/INTEGER |
| `orders` | `chk_o_totals` | `grandTotal = subtotal + shippingTotal + taxTotal` |
| `orders` | `chk_o_amounts_nonneg` | none of the four money columns is negative |
| `product_variants` | `chk_pv_price_nonneg` | `price >= 0` |
| `product_variants` | `chk_pv_inventory_sane` | `inventoryQuantity >= -1000000` — Shopify permits oversell, so this only rejects corruption |

Plus the database default collation: `utf8mb4` / `utf8mb4_unicode_ci`, matching every table
Prisma creates and the server defaults in `docker-compose.yml`.

**What remains application-level.** These span rows or tables, so no row-level CHECK can
express them and **no database guarantee backs them** — the code is the only enforcement:

- `Order.status = SYNCED` ⇒ `shopifyOrderId IS NOT NULL`
- `Order.status = DRAFT_CREATED` ⇒ `shopifyDraftOrderId IS NOT NULL`
- `isActive = false` ⇒ `deactivatedAt IS NOT NULL` (Product and ProductVariant)
- `Product.isActive = false` ⇒ all of its variants are `isActive = false`

Each one is a candidate for a periodic consistency sweep rather than a trigger; a trigger
would move business rules into the database, where they cannot be tested with the rest of
the code.

---

## 8. Cross-cutting engineering rules

- **Logging.** Structured JSON, single logger module. `console.log` banned by lint. Every line
  carries `{ service, queue, jobId, orderId | syncRunId, attempt }`. **Never logged:** API tokens,
  full addresses, full phone numbers, email addresses, customer names. Redaction list covers
  `authorization`, `x-shopify-access-token`, `password`, `email`, `phone`, `address*`, `customer*`.
  Where a phone must be referenced for support, log the last 4 digits only.
- **Money.** `Decimal(18,4)` in MySQL, decimal.js in application code, serialized to the client as
  **strings**. No `number`, no `float`, no `parseFloat`. Binary floating point cannot represent most
  decimal fractions, and on a COD order the stored number is cash a courier physically collects.
  Rounding happens once, at line-total computation, half-up to currency precision.
- **PII retention — POLICY ONLY, NOT IMPLEMENTED.** The PII in this system is
  `Order.customerName`, `customerPhone`, `customerEmail`, `addressLine1`, `addressLine2`, `city`,
  `province`, `postalCode`, `countryCode`, `customerNote`. Intended policy: once an order reaches
  `SYNCED` and passes a retention window (default 30 days), redact those columns in place; Shopify
  remains the long-term record. **No purge job exists and no schema column tracks purge state.** The
  column and its index will be added in the same change as the job that writes them — a nullable
  timestamp nothing ever sets looks like a compliance control in review and is not one.
  Enforced today: ID-only job payloads, logger redaction, no raw webhook bodies persisted,
  `publicToken` instead of enumerable order URLs.
- **Secrets.** Server-only env, zod-validated at boot (fail fast). No `NEXT_PUBLIC_` variable holds a
  Shopify credential. `.env` gitignored; `.env.example` committed empty. `SHOPIFY_API_VERSION`
  explicitly pinned.
- **Prisma is the only DB access layer.** No raw `mysql2`, no second query builder, no `$queryRaw`
  except as a reviewed, parameterized exception. One `PrismaClient` singleton per process.
- **Next 16 specifics.** `params` / `searchParams` / `cookies()` / `headers()` are async and must be
  awaited. `proxy.ts` guards `/admin`; because Server Functions are POST-able directly, every admin
  action re-checks authorization inside its own body. `ioredis` / `bullmq` go into
  `serverExternalPackages` if the web process imports them (`@prisma/client` is automatic).

---

## 9. Identified risks

### 9.1 Race conditions

| # | Race | Status |
|---|---|---|
| R1 | Webhook / later page holds older data for an already-updated product | handled — `shopifyUpdatedAt` guard |
| R2 | Two sync runs overlap | handled — `concurrency: 1` + `activeLock` + heartbeat reclaim |
| R3 | Price changes between cart-add and checkout | handled — re-price at checkout, snapshot into `OrderItem` |
| R4 | **Two concurrent checkouts for the last unit** | **known gap** — read-then-act, no lock (§4.1) |
| R5 | Worker stalls / crashes mid-submit | handled — lease expiry + draft-ID phase-2 lookup |
| R6 | Full-run deactivation races a product created mid-run | handled — `createdAt < startedAt` rule |
| R7 | Sweeper enqueues while the original `add()` succeeds late | handled — `jobId = orderId` |
| R8 | Concurrent upsert of the same new product | handled by design, **requires P2002 retry in code** |
| R9 | `idempotencyKey` collision across customers | handled — `requestFingerprint` binding |
| R10 | Crashed sync holds `activeLock` forever | handled — `heartbeatAt` reclaim |

### 9.2 Duplicate-order risks

| # | Path | Mitigation |
|---|---|---|
| D1 | Double-click "Place order" | `idempotencyKey` + fingerprint match |
| D2 | Refresh / resubmit | same; confirmation is a GET on `publicToken` |
| D3 | `draftOrderCreate` response lost | `cod-<submissionKey>` tag pre-flight |
| D4 | `draftOrderComplete` response lost | exact `draftOrder.order` lookup by stored draft ID |
| D5 | Re-delivery after worker crash | lease claim + unique `shopifyDraftOrderId` / `shopifyOrderId` |
| D6 | Operator retry on a live `SYNCING` order | retry permitted only from `FAILED`; button disabled otherwise |

Residual: a draft created but never linked locally **and** whose tag failed to persist becomes a
stranded draft — inert, not an order, listed by reconcile for cleanup.

### 9.3 Pagination risks

| # | Risk | Mitigation |
|---|---|---|
| P1 | Cost explosion from `products × variants` nesting | conservative page sizes; adaptive shrink on throttle |
| P2 | Cursor never advances → infinite chain | assert `endCursor != previousCursor`; hard `pageIndex` cap; abort + alert |
| P3 | Records mutated mid-run are missed | watermark with negative overlap; nightly full run closes gaps |
| P4 | >100-variant products half-synced | `variantSyncComplete = false` makes it visible, not silent |
| P5 | `OFFSET` degrades deep storefront pages | keyset pagination over a composite index |
| P6 | Whole page-set held in memory | write per page |
| P7 | Cursor expiry during a long run | page jobs are short and chained |

### 9.4 Scaling risks

| # | Risk | Mitigation |
|---|---|---|
| S1 | Worker concurrency × Prisma pool > `max_connections` | explicit `connection_limit`, sized `concurrency + headroom` |
| S2 | Replicas each honouring their own rate limit | BullMQ `limiter` per queue across workers |
| S3 | Redis growth from retained jobs | `removeOnComplete` / `removeOnFail` caps |
| S4 | Full sync starves order submission | separate queues; priority rate budget; off-peak full sync |
| S5 | Next horizontal scaling duplicates clients | singletons per process |
| S6 | A worker accidentally run inside Next | lint boundary; worker entry outside the Next build graph |
| S7 | Traffic spikes hitting MySQL every render | `use cache` + `cacheLife` ≤ sync interval; composite indexes |
| S8 | `JobLog` / `WebhookEvent` grow unbounded | **not mitigated** — no retention sweep is implemented (§9.6) |

### 9.5 Security risks

| # | Risk | Mitigation |
|---|---|---|
| X1 | Token leaking to browser or logs | server-only env; redaction; never in a job payload |
| X2 | Forged webhooks *(bonus)* | HMAC-SHA256 over the **raw** body, timing-safe compare, `X-Shopify-Webhook-Id` dedupe |
| X3 | Price tampering | client sends `{ variantId, quantity }` only; price is unrepresentable in the request schema |
| X4 | Quantity / mass-assignment abuse | strict zod schema, integer bounds, per-line and per-order caps |
| X5 | **COD fraud** — no payment step, no fraud gate | per-IP and per-phone rate limiting, velocity checks, admin review. **No OTP** by decision — accepted residual risk |
| X6 | Cross-customer order disclosure via idempotency key | `requestFingerprint` binding (§4.3) |
| X7 | PII in logs, payloads, traces | ID-only payloads; redaction; no raw webhook bodies |
| X8 | Unauthenticated admin surface | `proxy.ts` guard **plus** in-function authorization |
| X9 | Order confirmation enumeration | `publicToken`, never `id` or `reference` |
| X10 | Supply-chain drift | `package-lock.json` committed; npm only |

### 9.6 Deliberate scope exclusions (not defects — decisions)

| Excluded | Consequence | What production would do |
|---|---|---|
| Inventory reservations | concurrent-checkout oversell (R4) | transactional per-order reservations with full lifecycle (§4.1) |
| PII purge job | customer PII retained indefinitely | scheduled redaction + `piiPurgedAt` column |
| `JobLog` / `WebhookEvent` retention | both tables grow without bound; `job_logs` grows fastest (one row per job **attempt**) and its indexes degrade first | scheduled pruning by age, or table partitioning by `startedAt` |
| Phone OTP | zero friction on fake COD orders | OTP or risk scoring before order creation |
| Tax / shipping | totals are subtotal-only | Shopify-side calculation with reconciliation |
| Multi-currency | single-currency assumption baked into app logic | per-market price rows |
| Sales-channel filtering | products visible regardless of channel publication | channel-aware sync query |
| Webhooks | staleness bounded only by the 10–15 min interval | HMAC-verified webhook ingestion |

---

## 10. Resolved decisions and remaining questions

**Resolved:** order creation via `draftOrderCreate` → `draftOrderComplete`; tax/shipping zero with
local subtotal authoritative; inventory re-checked but not reserved; single currency with `Decimal`;
all products synced with `ACTIVE`/`isActive` storefront filtering; single dev store, custom app token,
guest checkout; 10–15 min sync; worker a separate Node process; pinned API version; webhooks bonus;
no OTP; no multi-currency; minimal documented PII retention; never log tokens, full addresses or full
phone numbers.

**Still open (block later phases, not the schema):**

- **Admin authentication** — no `AdminUser` model yet; will be an additive migration.
- **Exact `SHOPIFY_API_VERSION`** string.
- **Deployment target** for both processes; managed Redis or not.
- **Lease / reclaim thresholds** — `ORDER_CLAIM_LEASE_SECONDS`, `SYNC_HEARTBEAT_STALE_SECONDS`,
  `PENDING_SYNC_GRACE_SECONDS`.
- **Country / address format** — a single-country, free-text address shape is currently assumed.
