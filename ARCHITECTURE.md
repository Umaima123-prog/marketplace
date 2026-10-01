# Architecture — COD Marketplace on Shopify

Status: **Phase 2 — product synchronization implemented, not yet run against a real store.**
MySQL 8.4 and Redis 7 run from `docker-compose.yml`, migration `20260929053009_init` is applied,
and the sync worker runs as a separate process (`npm run worker`). No storefront UI, no cart,
no checkout, no order submission yet.

---

## 1. Context and constraints

| Area | Decision |
|---|---|
| Web framework | Next.js **16.3.6** App Router + TypeScript (Turbopack default, async request APIs, `proxy.ts` not `middleware.ts`) |
| Database | MySQL, accessed **only** through Prisma |
| Queue | Redis + BullMQ |
| Catalog source | Shopify Admin **GraphQL** API, version **pinned in configuration** (`SHOPIFY_API_VERSION`) |
| Shopify app | Single **development store**, custom app with an Admin API access token — **no OAuth install flow** |
| UI foundation | AdminLTE v3.2.0, CSS only, vendored at `vendor/adminlte/adminlte.min.css` (F3) |
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

**Consequence, observed live and left as-is:** while the Shopify demo seed catalog was in place,
the store contained a product with the handle `the-hidden-snowboard`. It was `ACTIVE` in Shopify, so
the storefront listed it. "Hidden" there refers to sales-channel publication -- a product can be
active yet unpublished to the Online Store -- and this project deliberately does not read publication
state. Filtering it would need `publishedOnCurrentPublication` (or a `publications` query) in the
sync, a column to store it, and a third condition in the storefront predicate.

That product has since been archived along with the rest of the seed catalog, so **no live product
demonstrates this today**. The gap itself is unchanged: nothing in the sync reads publication state,
so an active-but-unpublished product would still be listed. Tracked as F6.

That is a scope decision, not a defect, and it is stated here rather than quietly patched: a
merchant who unpublishes a product from the Online Store while leaving it active will still see it
on this storefront. If that matters, the fix belongs in the SYNC (store the publication flag), not
in a storefront filter that would silently disagree with the data it reads.

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

### 3.6 Phase 2 as implemented

Implemented and exercised end to end against real MySQL and real Redis. **Not yet run against a
Shopify store** -- the credentials are unset, and the client correctly refuses with a terminal
configuration error rather than retrying.

| Concern | File |
|---|---|
| Env, split core vs Shopify | `src/lib/env.ts` |
| Logger, redaction | `src/lib/logger.ts` |
| Prisma singleton, P2002 predicate | `src/lib/prisma.ts` |
| Redis connections | `src/lib/redis.ts` |
| Queue names, payloads, job options | `src/lib/queues.ts` |
| Admin GraphQL client | `src/lib/shopify/client.ts` |
| Failure taxonomy | `src/lib/shopify/errors.ts` |
| Cost/throttle arithmetic (pure) | `src/lib/shopify/throttle.ts` |
| Queries, page sizes | `src/lib/shopify/queries.ts` |
| GraphQL -> row mapping (pure) | `src/lib/sync/product-mapper.ts` |
| Sync decisions (pure) | `src/lib/sync/decisions.ts` |
| Writes, upsert races, sweep | `src/lib/sync/catalog-repo.ts` |
| Run lock, heartbeat, finalisation | `src/lib/sync/sync-run.ts` |
| Durable job history | `src/lib/jobs/job-log.ts` |
| Processors | `src/worker/processors/*.ts` |
| Worker entry, schedulers | `src/worker/index.ts`, `src/worker/scheduler.ts` |
| Manual trigger | `app/api/admin/sync/route.ts` |

**Deviations from the plan above, and why.**

- **No `SyncRun.failures` column.** §3.2 assumed a counter. There is none in the schema, and
  deriving one from `JobLog` would count transient attempts that later succeeded, which would
  block the sweep almost every run. Instead a page that exhausts *all* its attempts sets
  `SyncRun.status = PARTIAL`, so the run's own status is the durable record of "a page was
  permanently lost" -- exactly the condition the sweep gate needs. No migration was added.
- **Shopify credentials are validated on first use, not at import.** The web process never calls
  Shopify, so requiring a token to boot Next would enforce the opposite of the §2 boundary, and
  would make `next build` need a production credential.
- **Variant chains carry `syncRunId`** so a long chain refreshes the run heartbeat; without it a
  product with thousands of variants looks like a dead run to the reclaimer.

**Storefront completeness rule.** `Product.variantSyncComplete = false` means the stored variant
set is **truncated**, and the storefront must not present that product as complete. The flag flips
to true only when Shopify reports `hasNextPage: false`; a chain that dies halfway leaves it false,
which is a durable, visible statement rather than a silent lie.

### 3.6b When a run may be called COMPLETED

`SyncRun.status = COMPLETED` is a claim about the whole catalog, because it is what
unlocks the sweep. It is written only when **all** of these hold:

1. **Every page succeeded.** A page that exhausts its attempts calls `failSyncRun`, which
   ends the run `PARTIAL` and releases the lock. This is not optional bookkeeping: page N is
   what enqueues page N+1, so a permanently failed page means no later job exists and nothing
   would ever finalise the run. It would otherwise sit `RUNNING`, holding the lock until the
   heartbeat went stale, while reporting a state that is not true.
2. **The last page's transaction committed.** Finalisation happens after it, in the same job.
3. **The sweep completed**, when the gate allowed one. The sweep runs *before* the status is
   written, so if it throws, the job fails, the run stays `RUNNING`, and BullMQ retries the
   page. A run is never `COMPLETED` with an unfinished sweep.
4. **The run still belongs to this job.** Finalisation re-reads the row and refuses to write a
   status onto a run that was reclaimed or finalised by someone else.

**Variant chains are the deliberate exception.** A run may complete while chains are still in
flight, because every product they cover carries `variantSyncComplete = false` -- an explicit,
durable statement that its variant set is truncated (§3.3). The count is recorded on the
completion log line, so `COMPLETED` is never read as a stronger claim than it is.

A page that finds its run already ended returns `abandoned: true` and writes nothing. The job
succeeds because retrying cannot help, but the flag keeps an empty success from looking like a
completed page.

### 3.6c Worker concurrency

| Queue | Concurrency | Why |
|---|---|---|
| `product-sync` | **1**, explicitly | Two orchestrators would race for one database lock and the loser would do nothing but log that it lost. The lock makes a second runner harmless; concurrency 1 makes it pointless too. |
| `product-sync-page` | 3 | Ceiling is Shopify's cost bucket, not CPU. Re-tune from `requestedCost` / `availableCost` on the `page_complete` line once real catalog sizes are known. |
| `variant-sync` | 3 | As above. |

**Cost pacing is process-local.** The Shopify client keeps the last observed
`throttleStatus` in module state, so the three page workers in one process share one view of
the bucket. Shopify meters that bucket **per shop**, so running N worker processes means N
partial views and roughly N times the intended request rate. Scaling the worker horizontally
in production therefore requires a **shared limiter** -- a Redis token bucket in front of every
Shopify call -- not a larger concurrency number. Tracked as S2.

### 3.6d Live verification against the development store

**Historical evidence, from Phase 2.** The figures below describe the Shopify demo seed catalog that
was in the store at the time -- 17 products, 26 variants, 18 images. That catalog has since been
archived and replaced; see 3a.2 for the current state. The runs are recorded as they happened and are
not restated against the new catalog.

Run against `merchant-product-enrichment-hub.myshopify.com`, triggered through
`POST /api/admin/sync` and processed by the separate worker.

| Run | Page size | Pages | Result |
|---|---|---|---|
| 1 | 50 (default) | 1 | COMPLETED in 2 382 ms; 17 products, 26 variants created |
| 2 | 50 (default) | 1 | COMPLETED in 1 270 ms; **0 created, 17 updated** -- counts unchanged, no duplicates |
| 3 | **5** (`SHOPIFY_PRODUCTS_PER_PAGE=5`) | **4** | COMPLETED in 4 067 ms; pages of 5, 5, 5, 2 |

Run 3 exists because 17 products fit in one default page, and a single-page run cannot
demonstrate cursor pagination -- it is indistinguishable from a hard-coded first page. The
page size is overridable by environment for exactly this reason; the committed default
remains 50.

Cost per page is measured, not assumed: **143 requested against a 2 000 bucket** at page
size 5, and **331** at page size 50. Either leaves the bucket healthy.

**Not exercised by live data:** nested variant pagination. The largest variant set on the
store is 5, so no product ever reported `variants.pageInfo.hasNextPage: true` and no
`variant-sync` chain was enqueued in any run. That path is covered by automated tests only
-- mapping of a 100-variant page, the continuation walk across three pages, and the rule
that `variantSyncComplete` flips to true only on `hasNextPage: false`. Creating a
100-variant product purely to exercise it was deliberately not done.

### 3.7 Known gaps in the sync (Phase 2)

| # | Gap | Effect | Status |
|---|---|---|---|
| S1 | **Webhook vs sweep race.** A `products/create` webhook (bonus scope, not yet built) could write a product *after* a FULL run's last page but *before* its sweep. The new row carries a different `lastSyncRunId`, so the sweep would immediately deactivate a product that exists. | A just-created product disappears from the storefront until the next full run. | **Open, documented.** Partial protection today: webhooks are not implemented, so the race cannot fire yet. When they are, the fix is to exclude rows created after `SyncRun.startedAt` from the sweep predicate, or to have webhook writes stamp the active run id. |
| S2 | **Cost pacing is per process.** Measured: 143 cost per page at page size 5, 331 at page size 50, against a 2 000 bucket. `lastKnownCost` is module state, so N worker processes each pace against their own view of a bucket that Shopify meters per shop. | With several workers, throttling is discovered by being rejected rather than avoided. | Open. A shared limiter (Redis token bucket) is the fix; single-process development does not need it. |
| S3 | **Images are hard-deleted on reconcile.** Correct today -- nothing references `ProductImage` -- but it is the one place the sync deletes rather than deactivates. | None now. | Accepted, noted so it is revisited if images ever get referenced. |
| S4 | **`shopCurrency()` is cached per process for the worker's lifetime.** A shop that changes its currency mid-process keeps writing the old code until restart. | Vanishingly rare; wrong currency codes on variants written after the change. | Accepted. |
| S5 | **A page abandoned because the run is no longer RUNNING returns success.** | **Closed.** The result now carries `abandoned: true` rather than looking like a completed page, and finalisation refuses to write a status onto a run it no longer owns. A page that permanently fails now ends the run itself (`failSyncRun`), because the chain is the run: no later page job would exist to finalise it. |
| S8 | **Nested variant pagination has never run against live data.** No product in the store comes close to 100 variants -- 5 at most in the archived seed catalog, 2 in the current one -- so `variant-sync` has never been enqueued outside tests. | A defect in the continuation chain would not have been caught by any live run. | Open. Covered by unit tests; would need a 100+ variant product, or a temporarily lowered `SHOPIFY_VARIANTS_PER_PAGE`, to exercise for real. |
| S6 | **No integration test against real MySQL.** | **Closed.** `npm run test:integration` runs 28 tests against a dedicated `marketplace_test` database: upserts, idempotency, DECIMAL round-trip, image reconciliation, a real P2002 collision, soft deactivation, the sweep including its NULL-safe predicate, and the lock/heartbeat/finalisation lifecycle. The harness refuses to start unless the database name ends in `_test`. |
| S7 | **`variant-sync` infers `currencyCode` from an already-written sibling variant.** A product whose inline variant page wrote nothing would fall back to `"USD"`. | Unreachable today -- a chain only exists when the inline page wrote 100 variants. | Accepted, guarded by the fallback. |

---

---

## 3a. Storefront (Phase 3)

Implemented and verified live. At the time that was against the 17-product Shopify demo seed
catalog; the catalog has since been replaced, and the storefront was re-verified against the current
one (3a.2).

| Concern | File |
|---|---|
| The only catalog read path | `src/server/catalog/catalog.service.ts` (`server-only`) |
| Decimal-safe money | `src/lib/money.ts` |
| Layout, navbar, card | `src/components/storefront/*` (server components) |
| Variant selector, gallery | `src/components/storefront/ProductPurchasePanel.tsx` (the only `"use client"`) |
| Pages | `app/page.tsx`, `app/products/[handle]/page.tsx` |

**The storefront never calls Shopify.** Proven, not asserted: the app was run with
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`
and `SHOPIFY_API_VERSION` blanked via `.env.local` (which Next loads with higher precedence than
`.env`). Listing and detail both returned 200 with full data, and the server log contained zero
Shopify lines. Had any storefront path touched the Admin API, `shopifyEnv()` would have raised a
terminal "not configured" error and the page would have 500'd.

**Prisma cannot reach a client component.** `catalog.service.ts` imports `server-only`, so an
import from a `"use client"` module is a build error rather than a convention. Nothing in `app/`
or `src/components/` imports Prisma or `src/lib/shopify/*`.

**Money never becomes a number.** Prices are `DECIMAL(18,4)` in MySQL, `Decimal` from Prisma, and
exact decimal strings everywhere after that. `formatMoney` resolves the currency symbol through
`Intl` using a zero amount and substitutes the real digits, because `Intl.NumberFormat` takes a
`number` and would defeat the point. `normalizeMoney` exists because `Decimal.toString()` strips
trailing zeros -- `15.0000` arrived as `"15"` next to `"9.99"`.

**Query shape.** Listing is one `findMany` with nested `select`; Prisma resolves each relation in
one additional query, so it is three queries regardless of product count, not 1 + 2N.
`descriptionHtml` is not selected for cards. Ordering is `publishedAt DESC, id DESC`, matching the
`(isActive, publishedAt, id)` index, with keyset pagination (never `OFFSET`) whose predicate
handles the trailing `publishedAt IS NULL` group explicitly -- `publishedAt < x` is NULL, not
true, for those rows.

### 3a.1a Purchase rules on the storefront

Every rule below is **presentation, never authorisation**. The browser decides what to *show*; the
server decides what may be *sold*, and re-reads every variant from MySQL at checkout through the
single `evaluateLine` rule. A shopper who defeats all of this still cannot buy a sold-out variant.

| Rule | Where | Behaviour |
|---|---|---|
| Sold out, per product | `toCard` in `catalog.service.ts` | `available` is true when **any** active variant is purchasable. False renders a *Sold Out* badge on the card. The product is still listed and still links through — the detail page explains which option is out of stock, which is more useful than a dead card |
| "From" pricing | `priceVaries` in `catalog.service.ts` | True only when the active variants differ in price, so `From $X` appears only where a range exists. `variantCount > 1` was the wrong test: two options at one price are not a range, and "from" would imply a cheaper option exists |
| Sold out, per variant | `ProductPurchasePanel.tsx` | Selecting a variant moves price, SKU and availability together. An unpurchasable selection shows a *Sold Out* badge, disables the quantity field, and relabels the greyed CTA *Sold Out*; switching back re-enables it |
| Quantity ceiling | `ProductPurchasePanel.tsx` | `min(MAX_LINE_QUANTITY, inventoryQuantity)` when the variant is tracked and in stock; the per-line cap of **99** otherwise. An untracked variant, or a tracked one at zero that is still purchasable (`inventoryPolicy = CONTINUE`), is not limited by stock |
| The ceiling is enforced by clamping, not by the input | `ProductPurchasePanel.tsx` | The quantity is clamped on every render, so switching from a 20-stock option to a 15-stock one cannot leave 20 in the field for a frame. `max` on the `<input>` is a convenience; the clamp is the rule, and it is the only value the component ever reads |
| Nothing about money crosses into the cart | `ProductPurchasePanel.tsx` | Add to Cart passes `(variantId, quantity)`. The price beside the button is display only; the cart page and the checkout each re-read it from MySQL |

The panel is the only client component on the storefront, and selection changes issue **no request**
— every variant's price, compare-at, SKU and availability arrives with the page.

### 3a.2 Current catalog (electronics)

The Shopify demo seed catalog was replaced with a 10-product electronics catalog. Products were
created **in Shopify** and reached MySQL only through the existing sync -- nothing is hardcoded in the
storefront, and no sync code changed to accommodate them.

| Current state | Value |
|---|---|
| Storefront-visible products (`isActive AND status = ACTIVE`) | **10** |
| Active variants across them | **19** — nine products carry two variants, the webcam one |
| Products with at least one synced image | **10 / 10** (one image each, Shopify CDN) |
| Inventory total across the 19 active variants | **319** |
| Products with every active variant at zero stock | **2** (ClearView webcam, SnapCharge charger) — shown as *Sold Out*, not hidden |
| Former seed products | **archived in Shopify**, retained locally as inactive rows |
| Former seed variants | **26, all inactive** (`deactivationReason = SHOPIFY_STATUS`) |
| Variants deleted in Shopify during the earlier catalog tidy-up | **5** inactive rows remain (`deactivationReason = MISSING_FROM_SYNC`) |

The five `MISSING_FROM_SYNC` rows are the earlier tidy-up's; the same five option names were later
re-created in Shopify as part of the final variant spec, so each arrived as a **new** variant with a
new Shopify id. A SKU such as `ELS-GRY` therefore exists on two local rows — one inactive row still
referenced by a historical `OrderItem`, and one active row the storefront sells. Nothing looks a
variant up by bare SKU, so this is history being preserved rather than ambiguity.

Nothing was deleted on either side: archiving is `productUpdate(status: ARCHIVED)` in Shopify, and the
sync deactivates locally rather than removing rows, so the 17 seed products and their 26 variants are
still present and still reachable by the one historical order that references one of them.

Two things this exercise established, both recorded elsewhere rather than here: the sync propagates a
product's status to its variants (the cascade fix), and `write_products` + `write_inventory` +
`read_orders` are required beyond the original read scopes.

### 3a.1 Storefront known gaps

| # | Gap | Status |
|---|---|---|
| F1 | **No `use cache` / `cacheLife`.** Both pages are `force-dynamic`, so every request hits MySQL. | Open. The intended design (§3.5) is time-based caching with a lifetime no longer than the sync interval. |
| F2 | **`next/image` bypassed.** Images render through `<img>`; using `next/image` needs every Shopify CDN host allow-listed in `next.config.ts`. | Open, two lint warnings record it. |
| F3 | **AdminLTE is vendored, not installed.** `vendor/adminlte/adminlte.min.css` (MIT). The npm package pulls ~60 transitive dependencies to deliver one stylesheet and cannot install reproducibly -- a transitive `husky` prepare script fails on a machine without husky, which left the package missing from `package.json` while its files sat in `node_modules`. | Closed by vendoring; the file header records version, provenance and update steps. |
| F4 | **No page-level rendering test.** Correctness is covered at the service layer and by manual checks; nothing automated asserts the pages render. | Open. Playwright would close it. |
| F5 | **Keyset pagination never exercised live.** The whole catalog fits one 24-card page -- 15 products when the seed catalog was live, 10 now. | Open; unit-tested, and the integration suite pages through a seeded set. |
| F6 | **Publication state is not synced**, so an active-but-unpublished product appears on the storefront (see §3.4). | Open, deliberate. |

---

## 4. Order flow — storefront → MySQL → BullMQ → worker → Shopify

### 4.1 Checkout request (synchronous part)

`POST /api/checkout`, or a Server Action with the same body:

1. **Validate** with a strict zod schema (unknown keys rejected). The cart is **client-held** and
   carries `{ variantId, quantity }` only — there is no server-side Cart table, so there is nothing
   stale to trust. **The phone number is validated and normalised to E.164 here**, which is before
   the order exists: a number Shopify refuses must never reach a committed order, because the
   rejection then arrives in a background worker where nobody sees it (D12).
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

Inventory is **re-read and validated server-side**, but **not reserved** -- Phase 4 ships this
knowingly: there is no `reservedQuantity` column, no row lock and no reservation table. Two
consequences, both accepted for this exercise and stated rather than hidden:

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

### 4.1b Phase 4 as implemented (cart + COD checkout)

Shopify submission is **not** part of this phase: no order reaches the Admin API yet, and no webhook
is consumed. What exists is the complete local path from "add to cart" to a committed `PENDING_SYNC`
order with a job waiting on the queue.

| Concern | File |
|---|---|
| Cart rules (pure: no React, no storage) | `src/lib/cart/cart-state.ts` |
| Wire types + the purchasability rule | `src/lib/cart/cart-view.ts` |
| Cart state in the browser | `src/components/cart/CartProvider.tsx` |
| Hydration hook | `src/components/cart/useHydratedCart.ts` |
| Cart page / navbar badge | `src/components/cart/CartView.tsx`, `CartBadge.tsx` |
| Hydration from MySQL | `src/server/cart/cart.service.ts`, `app/api/cart/hydrate/route.ts` |
| Request schema (no money field exists) | `src/server/checkout/checkout.schema.ts` |
| Request fingerprint | `src/server/checkout/fingerprint.ts` |
| Checkout decision + write | `src/server/checkout/checkout.service.ts` |
| HTTP entry point | `app/api/checkout/route.ts` |
| Checkout form / confirmation | `src/components/checkout/CheckoutForm.tsx`, `app/orders/[publicToken]/page.tsx` |
| Queue definition | `src/lib/queues.ts` (`QUEUE.SUBMIT_ORDER`, `enqueueSubmitOrder`) |

**Cart state.** `localStorage` key `marketplace.cart.v1`, holding exactly
`{ lines: [{ variantId, quantity }] }`. No price, no title, no availability -- not even as a cache,
because a cached price is a second answer to "what does this cost" and the wrong one would be the one
the customer saw. `serializeCart` writes only those two fields whatever the in-memory object holds,
and `parseCart` treats storage as hostile input: bad JSON, a previous format, an injected `price` key
or 10 000 lines all degrade to a valid cart rather than throwing on first paint. Read through
`useSyncExternalStore`, so cross-tab edits and same-tab writes converge on one value and there is no
second copy in React state to drift from it.

**Display vs decision.** `hydrateCart` (cart page, checkout summary) and `placeOrder` (the write) each
re-read every variant from MySQL. They share one rule -- `evaluateLine` in `cart-view.ts` -- because
two implementations of "can this be bought" would eventually disagree and the customer would be shown
the wrong one. What they do with the answer differs: hydration marks the line and drops it from the
subtotal; checkout refuses the whole order.

**The browser cannot express a price.** `checkoutSchema` is `.strict()` and has no money field at all,
so `price`, `subtotal` or `grandTotal` in a request is a `400`, not a silently dropped key. That is
deliberately louder than stripping: a stripped field is invisible until the day someone wires
`input.price` into the `Order.create` call.

**Duplicate lines are rejected at the edge.** `OrderItem` is `UNIQUE (orderId, shopifyVariantId)`, so a
payload naming one variant twice would fail inside the transaction with a `P2002` indistinguishable
from an idempotency race. The schema refuses it instead, keeping that error in the request where it
belongs.

**Idempotency, as built.** `placeOrder` looks up `idempotencyKey` first and compares
`requestFingerprint` **before** returning anything: a match replays the stored order, a mismatch is
`409` and never hands back the other request's data. That lookup only narrows the window -- when two
identical requests race, both pass it and `UNIQUE(idempotencyKey)` decides. The loser catches `P2002`,
re-reads the winner, re-checks the fingerprint and replays it. Five concurrent identical requests
produce one order; that is an integration test, not an assumption.

**Queue handoff.** Enqueueing is injected into `placeOrder` (`deps.enqueueSubmit`) rather than
imported, which makes the ordering testable: the test's enqueuer reads the order back on a *second
connection*, so "visible" proves the transaction committed first. A replayed request does not enqueue
again. A refused cart enqueues nothing.

`enqueueSubmitOrder` uses a **fixed `jobId`** (`order--<orderId>`), the opposite of
`enqueueProductSync`'s `deduplication` key, and for the opposite reason: a fixed id deduplicates
against retained *completed and failed* jobs too. That was a bug for a manual sync trigger (3.6) and
is exactly the property wanted here -- the checkout request, a retry of it and the recovery sweep
cannot between them produce two submissions for one order. Recovering an order whose job reached a
terminal state therefore needs `replaceExisting: true`, which only the sweeper passes; the checkout
path cannot displace an in-flight submission.

**If the enqueue fails** (Redis down), the customer's order still succeeds. It is committed and
`PENDING_SYNC`, which *is* the outbox, and the recovery strategy is the sweep described in 4.1:
re-enqueue `PENDING_SYNC` orders older than a grace interval, with the same `jobId`. Failing the
request instead would invite a browser retry, and a retry with a fresh idempotency key would place a
**second order for one delivery** -- strictly worse than a submission delayed by minutes. Tested:
order present, status `PENDING_SYNC`, `submissionKey` set, `shopifyDraftOrderId` null, and the retry
replays instead of duplicating.

**Confirmation pages are addressed by `publicToken`**, 24 random bytes base64url, never by `reference`
or `id`. The reference is short and spoken aloud during support calls, so it is guessable by design;
if it addressed this page the order table would be enumerable. The page shows first name, city,
country, totals and line items -- no phone, no email, no street address, because anyone holding the
link can open it. An unknown token and someone else's token are the same `404`.

**PII in logs.** Checkout logs `event`, `orderId`, `itemCount`, `status` and `durationMs`. It never
logs the request body, the address, the phone number or the email; the route handler does not log the
body either. `REDACT_PATHS` in `src/lib/logger.ts` is the backstop for the day someone logs a whole
`Order` row while debugging, and now covers `city`, `province` and `postalCode` too -- a city plus a
postal code plus a name identifies a household. Exercised by `tests/unit/logger-redaction.test.ts`
against a real pino instance rather than asserted as configuration.

#### 4.1c Phase 4 known gaps

| # | Gap | Why it is acceptable now |
|---|---|---|
| C1 | **No inventory reservation.** Two simultaneous checkouts for the last unit can both succeed. | Documented above and in 9.1; a half-built reservation counter that drifts is worse than an honest race. This is the largest known correctness gap in the project and it is deliberate. |
| C2 | **The `PENDING_SYNC` recovery sweep is not implemented yet.** An order whose enqueue failed stays `PENDING_SYNC` until something re-enqueues it. | The submit-order worker phase owns it; everything it needs (the `[status, createdAt]` index, the stable `jobId`, `replaceExisting`) is already in place, and no order is lost meanwhile. |
| C3 | **No submit-order worker.** Jobs accumulate on the queue and are never consumed. | Intentional phase boundary -- the local order path is reviewable on its own. |
| C4 | **No rate limit on `POST /api/checkout`.** A script can create orders as fast as it can invent addresses. | Guest checkout has no account, so there is no cheap identity to limit on; a real deployment limits at the edge. Order creation is bounded by real stock and every order is visible to an operator. |
| C5 | **No retention or erasure policy for order PII.** Rows keep name, phone and address indefinitely. | Recorded in 8 as unimplemented; it is a data-lifecycle feature, not a checkout one. |
| C6 | **No UI component tests.** Cart and checkout components are covered only through their pure logic and their server endpoints. | No component-test harness exists in this project (`npm test` is a Node-environment Vitest config with no DOM), and adding one is its own decision. The rules worth protecting live in `cart-state.ts`, `cart-view.ts` and the services, and those are tested directly. |
| C7 | **The cart needs a round trip before it can show prices.** A cold cart page renders a loading line first. | The alternative is trusting stored prices. The trade is deliberate and the loading state is one line of text. |
| C8 | **A stale summary can disagree with the order actually placed.** The customer may have seen 19.99 and be charged 24.50. | The server's re-read wins by design, and a line that became unsellable returns `409 cart_invalid` with the form stating that nothing was ordered. A price that merely changed is not blocked; the confirmation page shows the authoritative total. |

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
 6. else draftOrderComplete(id: shopifyDraftOrderId, paymentPending: <mode>)   ← see below
 7. persist shopifyOrderId + shopifyOrderName, status = SYNCED, submittedAt = now
```

**How "unpaid" is expressed, and why it is configuration.** This section originally specified
`draftOrderComplete(id, paymentPending: true)`. On 2026-07 that argument is DEPRECATED, with
the stated replacement: *"Create a draft with payment terms rather than marking the draft as
pending."* Payment terms were therefore implemented — and then the first live order revealed
that `draftOrderCreate` refuses them for this app:

> `The user must have access to set payment terms.`

`draftOrderCalculate` **accepts** the same input, so validating the input shape could not have
caught this; only the real mutation did. Both mechanisms are now implemented and selected by
`SHOPIFY_COD_PAYMENT_MODE`:

| Mode | Mechanism | State |
|---|---|---|
| `payment_pending` (**default**) | no terms on the draft; `draftOrderComplete(paymentPending: true)` | **In use. Verified live** — the resulting order is `PENDING` with the full amount outstanding. |
| `payment_terms` | `paymentTerms` on the draft; no `paymentPending` on completion | Blocked by the permission above. Non-deprecated, and the intended destination. |

**The default is a deprecated argument, and that is a debt with a deadline.** `paymentPending`
is present and functional on the pinned version, needs no extra permission, and means exactly
"the payment is pending" — but Shopify has already named its replacement, so a future API
version will remove it. **Migration: grant the app permission to set payment terms, then set
`SHOPIFY_COD_PAYMENT_MODE=payment_terms`.** That is the whole change; the code path exists and
is tested. Tracked as gap D10.

Two other field names in the original plan were also wrong, for the same reason — they were
written from memory rather than from the schema. See 4.2b.

The **claim is a lease, not a latch.** Including expired `SYNCING` rows in the claim set is what
makes a crashed worker recoverable; without it an order stranded in `SYNCING` is unreachable by any
retry, forever.

**Phase 2 is keyed by a locally-stored draft ID, not a tag search.** Once `shopifyDraftOrderId` is
persisted, "did this already become an order?" is an exact lookup by ID — strictly stronger than
querying by tag. And **a stranded draft is garbage, not a duplicate order**: drafts are inert, do not
decrement inventory, and are swept by reconciliation. The expensive failure mode lives in the cheap
phase.

Line prices are sent **explicitly** from local snapshots. The field names for explicit pricing,
`taxExempt` and the zero shipping line were confirmed against the pinned API version by
introspection, and the whole input was then validated with `draftOrderCalculate` — which prices a
draft without persisting one. See 4.2b.

### 4.2b Phase 5 as implemented (the submit-order worker)

The local order path (Phase 4) ended with a `PENDING_SYNC` row and a job on the queue that
nothing consumed. This phase consumes it.

| Concern | File |
|---|---|
| Lifecycle transitions, claim/lease, recovery queries | `src/lib/orders/order-repo.ts` |
| The two-phase submission | `src/lib/orders/submit-order.ts` |
| Order rows -> DraftOrderInput (pure) | `src/lib/orders/draft-order-input.ts` |
| Real Shopify calls; userErrors -> permanent | `src/lib/orders/shopify-port.ts` |
| Mutations and queries | `src/lib/shopify/order-mutations.ts` |
| COD payment terms resolution | `src/lib/orders/payment-terms.ts` |
| The outbox drain | `src/lib/orders/recovery.ts` |
| Processors | `src/worker/processors/submit-order.ts`, `order-recovery.ts` |

**Lifecycle.** `PENDING_SYNC -> SYNCING -> DRAFT_CREATED -> SYNCED`, with `FAILED` reachable
from either working state. Every transition is a CONDITIONAL `updateMany` carrying the
expected state in its WHERE clause, never a read followed by a write. That is the entire
mechanism by which two workers cannot submit one order twice: both may read `PENDING_SYNC`,
but only one `UPDATE ... WHERE status = 'PENDING_SYNC'` affects a row, and the loser sees
`count: 0` and stands down. Five simultaneous claimers producing exactly one claim is an
integration test against real MySQL, not an assumption about InnoDB.

**The claim is a lease.** `claimedAt` plus `ORDER_CLAIM_LEASE_SECONDS` (default 300). A
`SYNCING` row whose claim is older than the lease belonged to a worker that died and is
reclaimable — without that, one crash strands an order forever. The lease must exceed a
worst-case submission (two Shopify round trips plus internal retries); 300s against BullMQ's
120s `lockDuration` leaves real headroom. `attempt` counts CLAIMS rather than BullMQ
attempts, deliberately: it survives a crash, which is what "how many times has this been
tried" should mean.

**Idempotency, four ways, none of them BullMQ.** The queue's job id is layer zero; every
actual guarantee is a MySQL conditional write or a Shopify lookup:

| Situation | What happens | Why not a duplicate |
|---|---|---|
| `SYNCED` with `shopifyOrderId` | claim refused, job returns success | nothing left to do; a claim would be the first step toward a second order |
| `DRAFT_CREATED` with a stored draft id | resume at completion | the stored id is trusted with no round trip: this system wrote it |
| no draft id, but a draft exists | tag pre-flight `tag:"cod-<submissionKey>"` finds and adopts it | covers the window where `draftOrderCreate` succeeded and its response was lost |
| draft already completed | `draftOrder(id:)` lookup adopts its order | covers a lost `draftOrderComplete` response |

The draft id is persisted IMMEDIATELY after creation, before completion is attempted — the
most important write in the phase. An integration test asserts it from *inside* a failing
completion: at the moment completion throws, the row already says `DRAFT_CREATED` with the
id.

**Error classification.** Retryable: transport failures, 429/THROTTLED, 5xx, and anything
unrecognised (a MySQL deadlock must not fail an order). Permanent: mutation `userErrors`,
GraphQL-level errors, auth failures, and four self-diagnosed cases
(`duplicate_submission_key`, `draft_not_found`, `complete_without_order`,
`checkpoint_lost_claim`). A retryable failure RELEASES the claim before rethrowing — back to
`DRAFT_CREATED` if a draft exists, `PENDING_SYNC` if not — so the retry can claim immediately
instead of waiting out the lease. A permanent failure, or a retryable one on the last
attempt, marks `FAILED` and **keeps `shopifyDraftOrderId`**: the draft may exist, and an
operator retry must resume it rather than create a second one.

Mutations are called with `maxAttempts: 1`, overriding the client's internal retry. That
retry is right for a read and wrong for a mutation that creates something: an inline retry
after an ambiguous failure risks two drafts. Retrying is BullMQ's job, and by then the tag
pre-flight exists to notice the first draft.

**Job history.** One `JobLog` row per attempt, carrying queue, job name, BullMQ id, attempt,
order id, duration, the retryable verdict, a safe error — and `startStatus` -> `endStatus`,
two columns added this phase. Without them, reading a submission's history means joining
every attempt back to a row that has since moved on; with them, `PENDING_SYNC ->
DRAFT_CREATED` is on the row. `retryable` is recorded rather than re-derived, because the
taxonomy can change and history must not.

**What the API actually wanted.** Three field names in the original plan were wrong, all
found by introspecting 2026-07 rather than at runtime:

- `draftOrderComplete(paymentPending:)` is deprecated -> COD is expressed as
  `paymentTerms` on the draft. The template is discovered per shop (ids are per shop) with
  `FULFILLMENT` ("Due on fulfillment" — pay when it arrives) preferred over `RECEIPT`, and
  NET/FIXED never used: either would tell the merchant the money is due in 30 days.
- a variant line item's explicit price is `priceOverride: MoneyInput`.
  `originalUnitPrice` and `originalUnitPriceWithCurrency` are documented as *"ignored when
  `variantId` is provided"* — they are for custom line items, so using one would have
  silently handed Shopify the current catalog price instead of the price the customer was
  quoted.
- `ShippingLineInput.price` is deprecated in favour of `priceWithCurrency`.

The complete input was then validated against the live API with `draftOrderCalculate`, which
prices a draft without persisting one: zero `userErrors` for the guest-COD shape, including
`paymentTerms` with no customer attached.

**Access scopes.** The app version must declare four:

| Scope | Needed for |
|---|---|
| `read_products` | catalog sync |
| `read_inventory` | `inventoryQuantity` / `tracked`, for the checkout stock check |
| `write_draft_orders` | `draftOrderCreate`, `draftOrderComplete` |
| `read_draft_orders` | the submission's two recovery lookups |

`read_draft_orders` is genuinely required — without it the completion guard
(`draftOrder(id:)`) and the lost-response pre-flight
(`draftOrders(query: 'tag:"cod-<key>"')`) both fail, which would remove the protection
against creating a second draft. In practice Shopify grants it implicitly alongside
`write_draft_orders`: on the development store `currentAppInstallation.accessScopes` returns
all four, and both lookups were executed against the live API and allowed. It is documented
explicitly regardless, because "implied by another scope" is not something a reviewer should
have to infer, and an app version declaring the write scope alone would look under-specified.

**Protected customer data.** A COD parcel cannot be delivered without a name, a phone number
and an address, so `draftOrderCreate` sends all four of Shopify's **Level 2** protected
customer fields:

| Field sent | Where it goes |
|---|---|
| name | `shippingAddress.firstName` / `lastName`, split from `Order.customerName` |
| email | `email` — omitted entirely when the customer gave none |
| phone | `phone` and `shippingAddress.phone` |
| address | `shippingAddress.address1`, `address2?`, `city`, `zip?`, `countryCode` |

Level 1 is protected customer data excluding those four; Level 2 includes them. Shopify
documents Level 2 as *always available* to a custom app, with no review required on a
development store.

**Before** the app was reinstalled through its Custom distribution link, it was not approved:
`draftOrderCalculate` refused to return the `CalculatedDraftOrder` object at all (*"This app
is not approved to access the CalculatedDraftOrder object"*), at the OBJECT level rather than
the field level — it fired even for a selection containing no customer field. **After** the
reinstall the same request is allowed and the object is returned. That gate is closed.

These fields were never removable to get past the requirement, and were not removed. An order
with no address is not a deliverable order, and a COD system that drops the phone number
produces parcels no courier can complete.

Every selection in `order-mutations.ts` still asks for no customer field back — only `id`,
`name`, `status` and the nested `order { id name }` — so the read side needs no Level 2 access
regardless.

#### Live validation on API 2026-07 (nothing persisted)

`draftOrderCalculate` prices a draft without creating one, so the exact input the shipped
mapper produces was validated against the live store. Three variants, guest COD, real variant
id, synthetic customer data:

| Input | userErrors | `CalculatedDraftOrder` | amount due now | amount due later |
|---|---|---|---|---|
| full COD input + `paymentTerms` (Due on fulfillment) | **none** | returned | **0.0** | **1899.9** |
| same input, no `paymentTerms` | none | returned | 1899.9 | 0.0 |
| full COD input + `paymentTerms` (Due on receipt) | none | returned | **0.0** | **1899.9** |

The middle row is the one that justifies the design: **without** payment terms Shopify treats
the whole amount as due immediately, and **with** them it is due later and nothing is due now.
That is unpaid-on-delivery semantics, evidenced rather than assumed — the strongest confirmation
obtainable without completing a real draft, and it narrows D1 considerably without closing it.

The rest of the response confirms the other three decisions: `subtotal` 1899.9 = 949.95 x 2
exactly, `totalShippingPriceSet` 0.0, `totalTaxSet` 0.0 with **zero** tax lines (so `taxExempt`
took effect), and `allVariantPricesOverridden: true` (so `priceOverride` took effect and the
snapshot price, not the catalog price, is what Shopify priced).

Nothing was persisted, verified by searching for the probe's submission tag afterwards: 0
drafts with that tag, 0 drafts tagged `COD` at all, and the 10 draft orders on the store all
predate the validation by four days.

**A bug this caught.** The first run returned one `userErrors` entry: *"Title Tag exceeds the
maximum length of 40 characters"* on `tags.1`. The submission tag was `cod-` + the
`submissionKey`, and a 36-character `randomUUID()` makes that **exactly 40** — sitting on
Shopify's limit with zero margin. Any later change (a longer prefix, a different key
generator, or any key nearer the `VARCHAR(64)` column width) would have produced an over-long
tag, which Shopify returns as a `userErrors` entry, which this project classifies as
PERMANENT — so **every order would have failed immediately and unretryably**, with the
lost-response recovery tag it depends on never being written. `submissionTag` now strips the
key's separators (a UUID becomes 32 hex characters) and truncates to the remaining budget, so
the worst case a `VARCHAR(64)` key can produce is exactly 40. Unit tests assert the bound for
a real key and for a 64-character one, and the writer and the tag search both derive the tag
from the same function so they cannot drift.

**Recovery.** The Order row IS the outbox, and this is what makes that true rather than
aspirational. A repeatable `order-recovery` job (default every 5 minutes) re-enqueues three
populations with `replaceExisting: true`:

- `PENDING_SYNC` older than `ORDER_RECOVERY_GRACE_SECONDS` — the checkout enqueue failed, or
  Redis was flushed;
- `DRAFT_CREATED` older than the grace period — the process died between the two phases;
- `SYNCING` past the lease — the worker holding it died.

`replaceExisting` is the subtle part: a fixed job id deduplicates against retained COMPLETED
and FAILED jobs too, so without it the sweep would find an exhausted order every five
minutes, enqueue nothing, and report success. The sweep never throws — a failure to repair
must not take the worker down — and it is gated by its OWN flag,
`ORDER_RECOVERY_ENABLED`, not by `SYNC_SCHEDULERS_ENABLED`. Sharing that flag would mean
silencing scheduled catalog sync for a controlled run also silently stops orders being
recovered, which are not the same decision.

**Concurrency 1**, as specified. The claim already makes a second consumer safe; concurrency
1 additionally keeps submission roughly FIFO, so the customer who checked out first is sent
first. It caps order throughput at one submission at a time (two Shopify round trips each);
raising it needs the cross-process cost limiter first (gap S2).

**PII.** A submission logs `orderId`, `attempt`, `startStatus`, `endStatus`, `itemCount`,
`durationMs` and safe Shopify error fields. Never the address, phone, email or totals. The
customer's data leaves this system in exactly one place — `buildDraftOrderInput` — and
`failureReason`/`lastError` carry Shopify's own refusal text, never the input that caused it.

#### 4.2d Verified live, end to end

One controlled order was submitted to the development store. Before: 0 local orders, 0 Shopify
orders, 0 drafts tagged `COD`. After: exactly one of each.

| Stage | Result |
|---|---|
| checkout → local order | `PENDING_SYNC`, one order, one item |
| BullMQ → worker | claimed, `startStatus: PENDING_SYNC` |
| `draftOrderCreate` | one draft, id persisted immediately (`paymentTerms: absent`) |
| local checkpoint | `DRAFT_CREATED` |
| `draftOrderComplete` | one order, `#1001` |
| local terminal state | `SYNCED`, lease released, `submittedAt` set, `failureReason` null |
| Shopify financial status | `displayFinancialStatus: PENDING`, `fullyPaid: false`, outstanding = full total |
| totals | local `grandTotal` = Shopify `totalPrice`, to the cent |
| duplicates | 1 draft (status `COMPLETED`, its `order` matching the stored id), 1 Shopify order, 1 job id |
| PII in logs | 4 log files scanned: no name, phone, email, address, city, postcode, public token or idempotency key; no token, client secret or database password |

That closes D1. The two-phase submission, the checkpoint, the claim, the totals and the COD
financial status are now confirmed against the real API rather than against a fake port.

**Two defects the live run exposed, neither of which any test had caught:**

1. **BullMQ passes `(job, token)`.** The processor's second parameter was an injected
   dependency with a default value, so BullMQ's token string was passed in its place:
   `shopify.findDraftOrdersByQuery is not a function`. It failed before any Shopify call and
   the order was released back to `PENDING_SYNC`, so nothing was orphaned — but every
   submission would have failed. Fixed at the root: `build()` in `src/worker/index.ts` now
   wraps every processor as `(job) => processor(job)`, which removes the whole class of bug,
   and `resolveShopifyPort` validates what it is given and falls back to the real client, so a
   mis-registration degrades instead of throwing mid-submission.

2. **`replaceExisting` failed silently.** The removal of the retained terminal job was wrapped
   in `.catch(() => undefined)`, and success was inferred from `job.id === jobId` — which is
   true whether `add` created a job or merely returned the existing one. On a cold connection
   the removal failed, the add was deduplicated against the completed job, and the retry
   reported success while queueing nothing. Two BullMQ behaviours made the old code
   unfixable as written: `add` returns the pre-existing job, and `remove` reports a count even
   when there was nothing to remove. `enqueueSubmitOrder` now reads the job before deciding,
   verifies the removal by re-reading, and surfaces `removeError`; the recovery sweep counts a
   failed replacement as a failure rather than as work done. Covered by
   `tests/integration/submit-order-queue.integration.test.ts` against real Redis — the
   behaviour is BullMQ's, so it is tested against BullMQ.

A third, smaller finding: `JobLog` lost the successful attempt's row, because a submit job id
is fixed per order and its replacement restarted at attempt 1, colliding with the earlier
attempt-1 row. Recorded as D11 and since fixed with a `jobInstance` discriminator — the Order
row was correct and complete throughout, but job history is now complete too.

#### 4.2c Phase 5 known gaps

| # | Gap | Status |
|---|---|---|
| D1 | ~~No real Shopify order has ever been created by this code.~~ **RESOLVED.** One controlled live order ran end to end: one draft, one order `#1001`, local `SYNCED`, Shopify `displayFinancialStatus: PENDING` with the full amount outstanding, totals matching to the cent, no duplicates, no PII in logs. See 4.2d. | Closed. |
| D2 | ~~Protected customer data (Level 2) is not enabled for this app.~~ **RESOLVED.** After reinstalling through the Custom distribution link, `CalculatedDraftOrder` is returned and the full guest-COD input — name, email, phone, address — validates with zero userErrors. | Closed. The four Level 2 fields were never weakened or removed to work around it; the block was a configuration state on the app, and it is gone. |
| D3 | **`province` is not sent as structured data.** `MailingAddressInput` on 2026-07 has `provinceCode` and no free-text province; the checkout collects a name ("Punjab"), and sending a name as a code would be refused or resolved elsewhere. It goes in the order note instead. | Deliberate. A name -> code mapping per country is its own feature. |
| D4 | **No operator UI for FAILED orders.** A permanently failed order sits in MySQL with `failureReason` and `lastError` and nothing surfaces it. | The recovery sweep does not pick up `FAILED` (by design — it would retry a refusal forever), so this needs the admin screen. |
| D5 | **Stranded drafts are never swept.** An order that reached `DRAFT_CREATED` and then failed permanently leaves a real draft in Shopify. Drafts are inert — no inventory, no customer-visible order — but they accumulate. | Reconciliation job, not yet written. |
| D6 | **Shopify cost pacing is still process-local (S2).** Submissions now spend from the same per-shop bucket as the catalog sync, and two worker processes would each pace against their own partial view. | Unchanged from Phase 2; more consequential now. |
| D7 | **Inventory is still not reserved (C1).** A submission can therefore fail, or produce an unfulfillable order, because stock went to zero between checkout and submission. | Accepted, documented at 4.1. |
| D8 | **BullMQ's stall timer is shorter than the database lease** (120s vs 300s). A submission that outlives the stall timer is re-delivered, the re-delivery finds a live claim and stands down. If the original process actually died, nothing submits until the recovery sweep notices. | Bounded and self-healing: the worst case is one sweep interval of delay, never a duplicate. Tightening it means raising `lockDuration` or lowering the lease. |
| D9 | **`draftOrderComplete` is not idempotent by contract.** Safety comes from the lookup before it, which is a read-then-act with a window. | The window is small and the alternative — Shopify-side idempotency keys on this mutation — does not exist. The unique index on `shopifyOrderId` is the final backstop. |
| D10 | **COD relies on a DEPRECATED argument.** `draftOrderComplete(paymentPending: true)` is the default because `paymentTerms` — the documented replacement — is refused: *"The user must have access to set payment terms."* Present and functional on 2026-07, but Shopify has named its successor, so a future API version will remove it. | **Migration is one setting:** grant the app permission to set payment terms, then `SHOPIFY_COD_PAYMENT_MODE=payment_terms`. Both paths are implemented and unit-tested; only the permission is missing. Re-check on every API-version bump. |
| D11 | ~~`JobLog` can lose an attempt.~~ **RESOLVED.** A `jobInstance` column (BullMQ's `job.timestamp`) now discriminates one job instance from its replacement, and the uniqueness is `(bullJobId, jobInstance, attempt)` — so a replacement job's attempt 1 is recorded alongside the attempt 1 of the job it replaced, while re-logging a given attempt of a given instance stays idempotent. Migration `20260929172148_job_log_instance_discriminator`; the column defaults to `""` so pre-existing rows keep the old uniqueness among themselves. | Closed. Regression tests assert both attempt-1 rows persist with distinct instances, that attempts within one instance still number 1..n, and that the instance is recorded on a first attempt. |
| D12 | ~~An unusable phone number is only caught by Shopify, after the order exists.~~ **RESOLVED.** The checkout required a *non-empty* phone on the reasoning that formats vary by country and the courier is the real validator. The courier is not the first validator: `draftOrderCreate` answers `phone: Phone is invalid`, and by then the local order is committed and the shopper has seen a confirmation page, so the order can only reach `FAILED` in a worker where nobody sees it. Two real orders were lost that way. `customerPhone` now validates structurally and normalises to E.164 in the request schema, before the idempotency lookup, the variant re-read, the transaction and the enqueue. | Closed. The rule is calibrated against live data — it accepts both numbers Shopify accepted and rejects both it refused. `src/lib/phone.ts` records why a numbering-plan database is deliberately *not* behind it: wrong guesses there would reject real customers, which is the failure this fix exists to avoid. The **visibility** half is still open — see D4. |

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
  awaited. `ioredis` / `bullmq` go into `serverExternalPackages` if the web process imports them
  (`@prisma/client` is automatic). This paragraph previously described a `proxy.ts` guard over
  `/admin` and in-function authorization for admin actions; **neither was built**, and there is no
  `/admin` route — only the unauthenticated `POST /api/admin/sync` recorded as X8. If an admin
  surface is added, the guard belongs in `proxy.ts` (Next 16's replacement for `middleware.ts`) *and*
  inside each action, because a Server Function is POST-able directly.

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
| X8 | Unauthenticated admin surface | **not mitigated** — `POST /api/admin/sync` has no authentication and no authorization check, and the `proxy.ts` guard this row used to claim was never written. Anyone who can reach the web process can trigger a catalog resync. It enqueues a sync and nothing else — it cannot read or write an order, and the worker's database lock makes a flood of triggers collapse into one run — so the exposure is a denial-of-service and Shopify-quota concern rather than a data one (§9.6) |
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
