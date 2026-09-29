# Database

MySQL 8.4, accessed through Prisma 6. The schema is `prisma/schema.prisma`; the generated client
goes to `src/generated/prisma` and is gitignored.

Eight tables. Every column name is camelCase (Prisma's default) while table names are snake_case
via `@@map`, which is a deliberate inconsistency: renaming every column would have made the
hand-written SQL in the migrations harder to read against the schema.

## Character set and collation

The database is `utf8mb4` / `utf8mb4_unicode_ci`.

Two things worth knowing:

- MySQL **8.4 removed `--skip-character-set-client-handshake`**, which is the option most guides
  still recommend for forcing a server charset. Using it makes 8.4 refuse to start. The charset is
  set with `--character-set-server` and `--collation-server` instead.
- The design intended `utf8mb4_0900_ai_ci` (8.0's default, faster and more correct for
  case-insensitive comparison), but Prisma emits `utf8mb4_unicode_ci` in its generated migration
  SQL. Rather than create a mismatch between the schema and the database, the migration keeps
  `unicode_ci` and the deviation is recorded here and in `ARCHITECTURE.md`.

## Money

Every monetary column is `DECIMAL(18,4)`:

| Where | Columns |
|---|---|
| `product_variants` | `price`, `compareAtPrice` |
| `orders` | `subtotal`, `shippingTotal`, `taxTotal`, `grandTotal` |
| `order_items` | `unitPrice`, `lineTotal` |

No amount is ever a `FLOAT` or a JavaScript `number`. Arithmetic uses `Prisma.Decimal`; values
cross the wire as exact decimal strings. `src/lib/money.ts` holds the helpers, including
`normalizeMoney`, which exists because `Decimal.toString()` strips trailing zeros — that put
`"15"` next to `"9.99"` in the same response.

## Tables

### `products`, `product_variants`, `product_images` — Shopify-owned

Written **only** by the sync worker; never by the web app and never by an admin form.

| Table | Unique | Indexes |
|---|---|---|
| `products` | `shopifyProductId`, `handle` | `(isActive, publishedAt, id)`, `(lastSyncRunId)`, `(variantSyncComplete)` |
| `product_variants` | `shopifyVariantId` | `(productId, position)`, `(lastSyncRunId)` |
| `product_images` | `shopifyImageId` | `(productId, position)` |

- `(isActive, publishedAt, id)` is the storefront listing index, and the column order is the
  reason keyset pagination works: the list is `WHERE isActive = 1 ORDER BY publishedAt DESC, id
  DESC`, which this index serves without a sort.
- `shopifyVariantId` is unique **on the variant itself**, independently of its product. That is
  what lets a `variant-sync` job write page 2 of a >100-variant product long after the page job
  that wrote the product.
- `lastSyncRunId` is indexed because the soft-deactivation sweep is a set difference on it: rows
  not stamped with a complete full run's id are the ones missing from Shopify.
- `variantSyncComplete` is `false` while a variant chain is unfinished, so a truncated variant set
  is never presented as complete.
- Deactivation is **soft**: `isActive`, `deactivatedAt`, `deactivationReason`. Nothing in the
  catalog is hard-deleted, except images on reconcile (gap S3).

### `orders` — locally owned

| Concern | Columns |
|---|---|
| Identity | `reference` (unique, short, customer-facing), `publicToken` (unique, 32 random bytes) |
| Idempotency | `idempotencyKey` (unique), `requestFingerprint`, `submissionKey` (unique) |
| Lifecycle | `status`, `paymentMethod`, `attempt`, `claimedAt`, `submittedAt`, `failureReason`, `lastError` |
| Money | `currencyCode`, `subtotal`, `shippingTotal`, `taxTotal`, `grandTotal` |
| Customer (**all PII**) | `customerName`, `customerPhone`, `customerEmail`, `addressLine1`, `addressLine2`, `city`, `province`, `postalCode`, `countryCode`, `customerNote` |
| Shopify linkage | `shopifyDraftOrderId` (unique), `shopifyOrderId` (unique), `shopifyOrderName` |

Six unique indexes, and each one is a duplicate-prevention mechanism rather than bookkeeping:

- `idempotencyKey` — the final protection against two simultaneous submissions of one checkout.
  The application's pre-flight lookup narrows the window; this closes it.
- `submissionKey` — ties an order to at most one Shopify draft, and is what the recovery tag
  search is built from.
- `shopifyDraftOrderId` — two orders can never bind the same draft.
- `shopifyOrderId` — the final backstop against two Shopify orders for one local order.
- `publicToken` — addresses the confirmation page; unguessable so the table cannot be enumerated.
- `reference` — human-facing, and deliberately *not* used to address anything.

Two indexes support the worker:

- `(status, createdAt)` — the admin order list and the `PENDING_SYNC` re-enqueue sweep. **The
  `Order` row is the outbox**; there is no separate outbox table, because one would be 1:1 with
  the order, carry one event type, and add a whole class of "outbox says SENT / order says
  PENDING" divergence for nothing.
- `(status, claimedAt)` — the expired-lease sweep: `SYNCING` rows whose claim has gone stale.

### `order_items` — write-once financial history

Unique `(orderId, shopifyVariantId)`, index `(variantId)`.

- The unique pair forces quantity merging at checkout: one line per variant per order. A payload
  naming the same variant twice is rejected by the request schema rather than colliding here.
- `variantId` is a **nullable** FK with `ON DELETE SET NULL`: a catalog change must never cascade
  into financial history.
- Titles, SKU and `unitPrice` are **snapshots**, written once and never re-read from the catalog.
  An order must still read correctly after the catalog moves on. There is no `updatedAt`, because
  rows are immutable.

### `sync_runs` — one run at a time

`activeLock` is a **unique** column, and the lock is therefore MySQL's, not Redis'. That matters:
it holds across processes and survives a Redis flush. Insert-first acquisition, with
heartbeat-based reclaim (`(status, heartbeatAt)`) for a holder that died.

### `job_logs` — durable job history

Unique `(bullJobId, jobInstance, attempt)`. Indexes `(entityType, entityId, startedAt)`,
`(queueName, status, startedAt)`, `(status, startedAt)`.

BullMQ's own history lives in Redis, which this architecture treats as disposable — history that
vanishes on a `FLUSHALL` is not history. Every processor writes a row when an attempt starts and
updates it when it finishes, carrying duration, the retryable verdict, a safe error, and the
entity's status either side of the attempt (`startStatus` → `endStatus`).

`jobInstance` is BullMQ's `job.timestamp`, and it is in the unique key for a specific reason: a
`submit-order` job id is **fixed per order** and reused on every re-enqueue, so a replacement job
restarts at attempt 1 and used to collide with the attempt-1 row of the job it replaced. The row
was then silently dropped — which is how the winning attempt of the first real order ended up with
no history. The column defaults to `""` so rows written before it existed keep the old uniqueness
among themselves.

### `webhook_events` — reserved

Unique `shopifyWebhookId`, index `(topic, receivedAt)`. Webhooks are **not implemented**; the
table exists so adding them later is not a migration against live order data.

## Constraints Prisma cannot express

The init migration ends with hand-written SQL. Prisma has no schema syntax for `CHECK`, so these
would be lost on every `prisma migrate dev` if they were not in a migration file.

```sql
-- a line must be a real, non-negative, self-consistent line
CHECK (quantity > 0)
CHECK (unitPrice >= 0)
CHECK (lineTotal = unitPrice * quantity)

-- an order's grand total must equal its parts, and nothing may go negative
CHECK (grandTotal = subtotal + shippingTotal + taxTotal)
CHECK (subtotal >= 0 AND shippingTotal >= 0 AND taxTotal >= 0 AND grandTotal >= 0)

-- catalog data arrives from Shopify, so these guard a bad payload rather than our own code
CHECK (price >= 0)
CHECK (inventoryQuantity >= -1000000)
```

`lineTotal = unitPrice * quantity` is safe as an equality **because** both columns are exact
decimals — `DECIMAL * INTEGER` is exact decimal arithmetic in MySQL. The same test against a
`FLOAT` column would be a latent bug.

These are not decoration. `chk_oi_line_total` rejected a test fixture during development that had
set `lineTotal` to the unit price regardless of quantity, and the inventory bound only rejects
values that could come from a corrupt payload — Shopify legitimately permits negative inventory
for oversell.

## Invariants the schema implies but cannot enforce

Recorded because they are real rules that live in application code:

- `status = SYNCED` ⟹ `shopifyOrderId IS NOT NULL`
- `status = DRAFT_CREATED` ⟹ `shopifyDraftOrderId IS NOT NULL`
- `isActive = false` ⟹ `deactivatedAt IS NOT NULL`
- `Product.isActive = false` ⟹ all of its variants are `isActive = false`

## Test database

`TEST_DATABASE_URL` must name a database whose name ends in `_test`. The integration harness
refuses to start otherwise, unconditionally and with no bypass flag, because those tests
`TRUNCATE` every table — a flag to skip the guard is a flag someone will set.

The database itself is created by `docker/mysql/init/01-databases-and-grants.sh`, alongside the app
and shadow databases. That script runs **only when MySQL initialises an empty data directory**, so
on a volume that already exists it will not run again and the database has to be created by hand —
see [the README](../README.md#if-you-already-have-a-mysql-volume).
