# Verification

What was checked, how, and — equally important — what was **not** checked. Every number here was
produced by running the command shown. Where something is covered only by automated tests and
never by live data, this document says so rather than implying otherwise.

Last run: all five checks below, plus the live order in §4.

## 1. The five checks

| Command | Result |
|---|---|
| `npm test` | **284 passed**, 19 files |
| `npm run test:integration` | **185 passed**, 7 files (real MySQL + real Redis) |
| `npm run typecheck` | clean (`tsc --noEmit`, no output) |
| `npm run lint` | clean — 0 errors, 0 warnings |
| `npm run build` | clean — 9 routes compiled |

`npm test` needs no services: the unit config supplies placeholder `DATABASE_URL` /
`REDIS_URL` values so that importing a module which touches `env` does not require a developer's
`.env`, and nothing in the unit suite connects anywhere.

`npm run test:integration` requires `docker compose up -d`. It applies migrations to the test
database first, and the harness **refuses to start** unless `TEST_DATABASE_URL` names a database
ending in `_test` — those tests `TRUNCATE` every table, and a bypass flag is a flag someone will
set.

## 2. Unit suite (284 tests, 19 files)

Pure logic, fixtures and fake clients.

| Area | Files |
|---|---|
| Money | `money.test.ts` — exact-decimal comparison, rounding, formatting past `Number.MAX_SAFE_INTEGER`, and `normalizeMoney` (which exists because `Decimal.toString()` strips trailing zeros) |
| Catalog sync | `product-mapper.test.ts`, `sync-decisions.test.ts`, `catalog-repo.test.ts`, `pagination.test.ts`, `throttle.test.ts` |
| Shopify client | `shopify-auth.test.ts` — client-credentials exchange, caching, the single 401 re-exchange |
| Queues | `queues.test.ts` — job-id safety, including that no id can contain `:` |
| Environment | `env.test.ts` |
| Logging | `logger-redaction.test.ts` — exercised against a real pino instance rather than asserted as configuration |
| Cart | `cart-state.test.ts`, `cart-line-eval.test.ts` |
| Checkout | `checkout-schema.test.ts`, `checkout-fingerprint.test.ts` |
| Order submission | `draft-order-input.test.ts`, `submit-order-classification.test.ts`, `submit-order-port-resolution.test.ts`, `payment-terms.test.ts`, `cod-payment-mode.test.ts` |

Behaviours worth calling out, because they encode rules rather than mechanics:

- a cart cannot persist a price — `serializeCart` writes two fields whatever the object holds, and
  `parseCart` survives bad JSON, an older format, an injected `price` key and 10 000 lines
- the checkout schema **rejects** a browser-supplied `price`, `subtotal` or `grandTotal` rather
  than silently dropping it
- a request fingerprint is stable across harmless formatting differences (phone punctuation, name
  whitespace, cart ordering) and changes for every field that matters — including the case where a
  value moves between two adjacent fields
- `priceOverride` is the field used for a variant line item's explicit price, because
  `originalUnitPrice*` are documented as ignored when a `variantId` is present
- the submission tag stays inside Shopify's 40-character limit for a real key **and** for any key
  the `VARCHAR(64)` column can hold

## 3. Integration suite (185 tests, 7 files)

Real MySQL for everything, and real Redis for the queue tests. Shopify is faked; the database is
not — every claim in these tests is about what MySQL does under concurrent conditional updates,
which a fake database would prove nothing about.

| File | Covers |
|---|---|
| `catalog.integration.test.ts` | the storefront read path: visibility predicate, keyset pagination including the trailing `publishedAt IS NULL` group, no internal columns in responses |
| `catalog-repo.integration.test.ts` | upserts, idempotent re-runs, `DECIMAL` round-trip, a real `P2002` collision, soft deactivation, the sweep's NULL-safe predicate |
| `sync-run.integration.test.ts` | the run lock, heartbeat reclaim, finalisation |
| `cart.integration.test.ts` | hydration from MySQL, price changes reflected immediately, unavailable lines marked and excluded from the subtotal |
| `checkout.integration.test.ts` | price tampering rejected, unsellable lines blocked, Decimal-exact totals, idempotent replay, same key + different payload refused, a genuine concurrent `P2002` race, transactional rollback leaving neither order nor items, the submit job enqueued only after the order is visible on a second connection |
| `submit-order.integration.test.ts` | the claim/lease state machine, resume without a second draft, the `SYNCED` no-op, retryable vs permanent classification, `JobLog` contents, recovery, and duplicate prevention under concurrency |
| `submit-order-queue.integration.test.ts` | `enqueueSubmitOrder` against **BullMQ itself** |

That last file exists because a mock would have reproduced a bug rather than caught it. Two BullMQ
behaviours matter and neither is obvious: `add` with an existing job id returns the **pre-existing**
job (so `job.id === jobId` cannot distinguish "created" from "already there"), and `remove` reports
a count even when there was nothing to remove.

Specific proofs rather than general coverage:

- **Five simultaneous claims produce exactly one claim** — the conditional `UPDATE … WHERE status =
  'PENDING_SYNC'` serialised by InnoDB, not an assumption about it
- **The draft id is persisted before completion is attempted** — asserted from *inside* a failing
  completion: at the moment it throws, the row already says `DRAFT_CREATED` with the id
- **A resumed order creates no second draft** — verified by the fake port's call counts being zero,
  not by inspecting our own logic
- **Transactional atomicity** — the same write shape aborted after the items are created leaves
  zero orders and zero order items
- **`JobLog` records both attempt 1s** when a job is replaced under the same fixed job id, which is
  the D11 regression test

## 4. The live end-to-end order

One controlled cash-on-delivery order was taken on a Shopify **development store**. Identifiers are
truncated here; no customer data is reproduced, and the data used was synthetic and marked as a
test.

**Before**: 0 local orders, 0 Shopify orders, 0 drafts tagged `COD`.

| Stage | Observed |
|---|---|
| `POST /api/checkout` | `201`, reference returned, local order `PENDING_SYNC` |
| BullMQ → worker | claimed, `startStatus: PENDING_SYNC` |
| `draftOrderCreate` | one draft, id persisted immediately |
| local checkpoint | `DRAFT_CREATED` |
| `draftOrderComplete` | one order, `#1001` |
| local terminal state | `SYNCED`, lease released, `submittedAt` set, `failureReason` null |

**After**, verified by querying both systems:

| Claim | Evidence |
|---|---|
| exactly one local order | `orders` count `1`, one order item |
| exactly one Shopify draft | drafts tagged `COD` `1`; drafts with this submission tag `1`; stored draft resolves, status `COMPLETED`, its `order` matching the stored order id |
| exactly one Shopify order | store order total `0 → 1` |
| local status | `SYNCED` |
| `shopifyDraftOrderId` | `gid://shopify/DraftOrder/1081…549` |
| `shopifyOrderId` | `gid://shopify/Order/7040…797`, name `#1001` |
| COD financial status | `displayFinancialStatus: PENDING`, `fullyPaid: false`, outstanding = full total |
| totals agree | local `grandTotal` = Shopify `totalPrice`, to the cent; outstanding equals the total, so nothing was collected |
| no duplicate jobs | one job id; the retained `completed` job carries `outcome: "synced"` |
| no PII or secrets in logs | 4 log files, 25,986 bytes: no name, phone, email, address, city, postcode, public token or idempotency key; no access token, client secret or database password |

### Three bugs the live run exposed

Recorded because "it worked first time" would be untrue, and because each was a class of bug the
test suite could not have caught by construction.

1. **BullMQ invokes a processor as `(job, token)`.** The processor's second parameter was an
   injected dependency with a default, so BullMQ's token string arrived in its place:
   `shopify.findDraftOrdersByQuery is not a function`. It failed *before* any Shopify call and the
   order was released back to `PENDING_SYNC`, so nothing was orphaned — but every submission would
   have failed. Fixed at the root (the worker now wraps every processor to a single argument) plus a
   validating `resolveShopifyPort`. Regression tests: `submit-order-port-resolution.test.ts`.
2. **`replaceExisting` failed silently.** The removal of the retained terminal job was wrapped in
   `.catch(() => undefined)`, and success was inferred from the returned job's id. On a cold
   connection the removal failed, the add was deduplicated against the completed job, and the retry
   reported success while queueing nothing. Fixed by reading before deciding and verifying the
   removal; the sweep now counts a failed replacement as a failure. Regression tests:
   `submit-order-queue.integration.test.ts`.
3. **`paymentTerms` is refused for this app** — "The user must have access to set payment terms."
   `draftOrderCalculate` **accepts** the same input, so validating the input shape could not have
   revealed it. COD now uses `draftOrderComplete(paymentPending: true)` by default, selected by
   `SHOPIFY_COD_PAYMENT_MODE`. Regression tests: `cod-payment-mode.test.ts`. This remains an open
   gap (D10) because that argument is deprecated.

A fourth, smaller one was caught by `draftOrderCalculate` before the live run: the submission tag
`cod-` + a 36-character UUID is **exactly** Shopify's 40-character limit, so any longer key would
have failed every order permanently and unretryably.

### Cleanup

A second local order was created from a browser during the test window (not by the controlled
test). It failed on the payment-terms error before the fix, reached **no** Shopify resource, and was
deleted along with its `JobLog` row and its queue job. The deletion refused to run unless the order
still had no draft and no order id, and asserted the successful order intact afterwards.

## 5. Earlier live verification (Phases 2–3)

**These figures are historical and describe the Shopify demo seed catalog** — 17 products, 26
variants, 18 images, 15 of them storefront-visible — which was in the store when Phases 2 and 3 were
verified. That catalog has since been archived and replaced by a 10-product electronics catalog; the
current state is in §5a. The evidence below is recorded as it happened and deliberately not restated
against the new catalog.

| Claim | Evidence |
|---|---|
| Shopify authentication | client-credentials exchange against the real store; scopes read back and logged |
| First real sync | `COMPLETED`, 17 products / 26 variants / 18 images created |
| Idempotent re-run | `COMPLETED`, 0 created and 17 updated, counts unchanged, zero duplicates |
| Cursor pagination | a controlled run at page size 5 walked 4 pages (5, 5, 5, 2) with `hasNextPage` true, true, true, false; the sweep ran only after the final page; all 17 products stamped with the run id |
| Cost pacing | measured, not assumed: 143 per page at size 5, 331 at size 50, against a 2 000 bucket |
| Storefront | 15 cards for 15 `ACTIVE` products; `ARCHIVED` and `DRAFT` absent and 404 on detail; all four gift-card variant prices in the delivered payload; image-less product renders a placeholder; unknown handle 404 |
| Shopify independence | both storefront pages rendered with every Shopify credential blanked, and the server log contained no Shopify line |

## 5a. Current catalog state (verified after the electronics migration)

Distinct from §5: that section is historical, this one is the state of the system now. The 10
products were created **in Shopify** and reached MySQL only through the existing sync — nothing is
hardcoded in the storefront and no sync code changed for them.

| Claim | Evidence |
|---|---|
| 10 electronics products storefront-visible | `isActive = true AND status = ACTIVE` count is 10; the listing renders 10 cards |
| 19 variants active | 19 / 19 active, none carrying a `deactivationReason` |
| Prices, SKUs, inventory | verified row by row against the specification; 19 / 19 SKUs present; inventory total **500** — 501 as created, less one unit of `ELS-GRY` sold by the storefront order below |
| All 10 have a working image | 10 `ProductImage` rows, one per product, `position 1`, `https://cdn.shopify.com/…`; one URL fetched directly → HTTP 200, `image/png`, 1,349,958 bytes |
| Listing renders images | 10 CDN `<img>` sources, **0** "No image" placeholders (10 before the upload) |
| A detail page renders its image | `/products/axis-smartwatch` 200, one gallery image, no placeholder, no thumbnail strip (single image) |
| Variant switching | both variants' titles, prices and SKUs present in the delivered payload, so switching needs no request; a single-variant product shows no selector |
| Cart hydration | two electronics lines priced from MySQL, subtotal `269.97 USD`, `checkoutable: true` |
| Old seed products archived | 15 ACTIVE seed products archived in Shopify by handle; already-ARCHIVED and DRAFT ones untouched; **nothing deleted** |
| Old seed variants inactive | 26 / 26 inactive, all `deactivationReason = SHOPIFY_STATUS`; 0 variants active under an inactive product |
| Archived products absent from the storefront | 0 occurrences of `Snowboard`, `Gift Card` or `Ski Wax` on the listing; three archived detail pages 404 |
| Storefront still reads only MySQL | the web process log contains 0 Shopify references across every page load and API call; no storefront, cart, checkout or route module imports the Shopify client |
| The historical live COD order remains valid | `SYNCED`, with its draft and order ids and its price snapshots intact — archiving the product it references changed nothing about it. It is no longer the only order; see below |

No order was placed *during* the catalog migration itself.

**A second real order has since been placed through the storefront**, unprompted, on the new
catalog: 1 x Elevate Laptop Stand (`ELS-GRY`) for 34.99 USD, `SYNCED` locally on its **first**
attempt, and `PENDING` / unpaid in Shopify. Its idempotency key is a browser-minted UUID from
`CheckoutForm` and its customer details are not the synthetic fixture used in §4, so it came from
the storefront UI rather than from any script here.

Current order state: **2 local orders, 2 Shopify orders**, one-to-one, both `SYNCED` locally and
both `PENDING` / unpaid in Shopify. One is the controlled test of §4; the other is the storefront
order described here. Nothing was created accidentally — no checkout request was issued by any
verification script after §4, and this order predates the branding work that followed it.

That order is also the only end-to-end evidence for the **electronics** catalog: §4's controlled
test ran against a product from the old seed catalog.

## 6. What has NOT been verified live

Stated plainly, because the sections above are otherwise easy to over-read.

- **Nested variant pagination (>100 variants)** — no product in the store comes close: 5 variants at
  most in the archived seed catalog, 2 in the current one, so no variant-sync chain has ever been
  enqueued against live data. Automated tests only (S8).
- **Keyset pagination beyond page 1 at production page size** — exercised by lowering the page
  size to 5, not with a catalog large enough to need 50 (F5).
- **A second worker process** — concurrency safety is proven within one process and by database
  constraints; cost pacing across processes is a known gap (S2).
- **The `payment_terms` COD path** — implemented and unit-tested, but the permission to use it has
  not been granted, so it has never run against Shopify (D10).
- **The recovery sweep in anger** — it has been observed running and reporting zero work, and its
  logic is covered by integration tests, but no production incident has exercised it.
- **Concurrent-checkout oversell** — the race is documented (C1), not demonstrated.
- **UI rendering** — there are no component tests and no DOM test harness (C6, F4). Pages were
  checked by hand and by HTTP status.

## 7. Repository safety

| Check | Result |
|---|---|
| `.env` tracked? | no — matched by `.gitignore:34` (`.env*`) |
| `.env` in any commit? | no |
| Generated Prisma client | ignored (`.gitignore:45`, `/src/generated/`) |
| Shopify credentials in the tree | none — no `shpat_`/`shpca_`/`shpss_`, no client secret, no admin token |
| Database passwords | none — `.env.example` holds `REPLACE_ME` placeholders, plus deliberate `test:test` / `unused:unused` values in test configs |
| Customer PII | none. The only email in the repository is `ayesha@example.com` (RFC 2606 reserved) and phone numbers are the dummy `+92 300 1234567` pattern, both unit-test fixtures |
| Live order identifiers | not present in the repository — no reference, public token, draft id or order id |
