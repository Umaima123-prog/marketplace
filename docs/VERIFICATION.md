# Verification

What was checked, how, and — equally important — what was **not** checked. Every number here was
produced by running the command shown. Where something is covered only by automated tests and
never by live data, this document says so rather than implying otherwise.

Last run: all five checks below, plus the live order in §4.

A recorded walkthrough of the working system is linked from
[SUBMISSION.md](SUBMISSION.md): <https://www.loom.com/share/02fc3b42859640d9b1428029c730b425>. It is a demonstration, not evidence — every claim in
this document comes from running the command or query shown, not from the video.

## 1. The five checks

| Command | Result |
|---|---|
| `npm test` | **333 passed**, 23 files |
| `npm run test:integration` | **210 passed**, 7 files (real MySQL + real Redis) |
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

## 2. Unit suite (333 tests, 23 files)

Pure logic, fixtures and fake clients.

| Area | Files |
|---|---|
| Money | `money.test.ts` — exact-decimal comparison, rounding, formatting past `Number.MAX_SAFE_INTEGER`, and `normalizeMoney` (which exists because `Decimal.toString()` strips trailing zeros) |
| Catalog sync | `product-mapper.test.ts`, `sync-decisions.test.ts`, `catalog-repo.test.ts`, `pagination.test.ts`, `throttle.test.ts`, `variant-image.test.ts`, `sync-transaction-budget.test.ts` |
| Shopify client | `shopify-auth.test.ts` — client-credentials exchange, caching, the single 401 re-exchange |
| Queues | `queues.test.ts` — job-id safety, including that no id can contain `:` |
| Environment | `env.test.ts` |
| Logging | `logger-redaction.test.ts` — exercised against a real pino instance rather than asserted as configuration |
| Cart | `cart-state.test.ts`, `cart-line-eval.test.ts` |
| Checkout | `checkout-schema.test.ts`, `checkout-fingerprint.test.ts`, `phone.test.ts` |
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
- phone validation **agrees with Shopify** on all four number shapes this store has actually seen:
  it accepts the two Shopify accepted and rejects the two it refused, so the rule is calibrated
  against observed behaviour rather than taste

## 3. Integration suite (210 tests, 7 files)

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

**This section is a point-in-time record of that one run, against the Shopify demo seed catalog.**
The counts below — "0 local orders" before, "exactly one local order" after — were true at the time
and are deliberately left as they were recorded. They are **not** the current state: further
orders have been placed through the storefront since, and the live position is in
[§5a](#orders). The bugs in §4's subsections are likewise recorded as they happened rather than
tidied away.

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
| 19 variants active | 19 active; nine products carry two variants and the webcam one |
| Prices, SKUs, inventory | compared row by row against live Shopify in a single three-way check (spec / Shopify / MySQL): every option name, price, SKU, inventory quantity, `inventoryPolicy` and `tracked` flag agrees. Inventory total **318** across the 19 active variants — 319 when the spec was applied, and Shopify has since decremented `ELS-GRY` by one. Shopify and MySQL both read 318, which is the invariant that matters; the absolute number is the shop's to change |
| 2 products are entirely sold out | ClearView webcam and SnapCharge charger: every active variant at zero. Both still listed, badged *Sold Out*, with Add to Cart disabled |
| Images preserved through the variant work | 10 Shopify media and 10 `ProductImage` rows, unchanged; the convergence script asserts the media count per product before and after |
| 5 variants were removed in an earlier tidy-up | deleted then with `productVariantsBulkDelete` (`PWH-WHT`, `GGM-WHT`, `EBS-BLU`, `ELS-GRY`, `SCW-WHT`); each still survives locally as an **inactive** row with `deactivationReason = MISSING_FROM_SYNC`, so nothing was ever hard-deleted |
| Those five option names are back as new variants | re-created in Shopify for the final spec, so each has a **new** Shopify id and a new active local row. The inactive row keeps the historical `OrderItem` link; the active row is what the storefront sells |
| All 10 have a working image | 10 `ProductImage` rows, one per product, `position 1`, `https://cdn.shopify.com/…`; one URL fetched directly → HTTP 200, `image/png`, 1,349,958 bytes |
| Listing renders images | 10 CDN `<img>` sources, **0** "No image" placeholders (10 before the upload) |
| A detail page renders its image | `/products/axis-smartwatch` 200, one gallery image, no placeholder, no thumbnail strip (single image) |
| Variant switching | every variant's title, price, SKU and availability arrives with the page, so switching needs no request; a single-variant product shows no selector. Exercised in a real browser — see §5b |
| Cart hydration | Axis Smartwatch *46mm* ×2 hydrated from MySQL at `149.99` a unit, line total and subtotal `299.98 USD`, `checkoutable: true` |
| Old seed products archived | 15 ACTIVE seed products archived in Shopify by handle; already-ARCHIVED and DRAFT ones untouched; **nothing deleted** |
| Old seed variants inactive | 26 / 26 inactive, all `deactivationReason = SHOPIFY_STATUS`; 0 variants active under an inactive product |
| Archived products absent from the storefront | 0 occurrences of `Snowboard`, `Gift Card` or `Ski Wax` on the listing; three archived detail pages 404 |
| Storefront still reads only MySQL | the web process log contains 0 Shopify references across every page load and API call; no storefront, cart, checkout or route module imports the Shopify client |
| Both orders remain valid | each `SYNCED` with its Shopify ids and price snapshots intact. Neither archiving a product nor **deleting a variant** changed anything about them: the order whose variant was deleted still resolves to that variant row and still carries its price snapshot |

## 5b. Storefront UX verification (real browser, 58 checks)

The storefront has no DOM test harness (gap C6/F4), so the variant behaviour was verified the way a
shopper exercises it: a headless Chrome driven over the DevTools Protocol against the dev server,
clicking the real controls and reading the resulting DOM. No assertion below is inferred from source.

Two things that first run got wrong are worth recording, because both would have produced a false
pass or a false failure:

- Assigning `input.value` from script goes through React's own value tracker, which then suppresses
  the synthetic change event — the component never saw the edit. Driving the prototype's native
  setter is what makes the event real, which is what a keystroke does.
- The sticky summary is scoped to `min-width: 992px`, and the default headless window is 800px wide,
  so the first run read `position: relative` and reported a failure that was the harness's.

| Area | Verified |
|---|---|
| Pulse Wireless Headphones | defaults to the in-stock *Black* at `$79.99` / `PWH-BLK`, Add to Cart enabled. Selecting *White* changes the price to `$84.99`, the SKU to `PWH-WHT`, the badge to *Sold Out*, and disables both Add to Cart and the quantity field. Selecting *Black* again re-enables Add to Cart and restores `$79.99` |
| Nova Mechanical Keyboard | *Red Switch* `$89.99` / `NMK-RED` and *Blue Switch* `$94.99` / `NMK-BLU`; switching moves price and SKU together, both in stock, button enabled |
| SnapCharge Wireless Charger | card badged *Sold Out*; detail badged *Sold Out*; Add to Cart disabled and labelled *Sold Out*; still disabled after switching to the other sold-out option |
| ClearView Full HD Webcam | `$54.99`, *Sold Out*, Add to Cart disabled, and no option selector at all for a single-variant product |
| Catalog grid | 10 cards under *Featured Electronics*; every image tile measured square in the layout; *From* shown only where the active variants differ in price; exactly the two sold-out products carry the *Sold Out* badge |
| Quantity cap | Axis Smartwatch *46mm* has 15 in stock: typing 99 is clamped to 15. Switching to *42mm* raises the cap to its own 20; switching back clamps to 15 again |
| Cart | the line shows the chosen variant (*46mm*), its SKU, the server's unit price, the quantity, the line total and a subtotal of `$299.98`, with a thumbnail, a per-row Remove, and both *Checkout* and *Continue Shopping* |
| Checkout | two-column layout, cash on delivery stated in both the header chip and the payment card, order summary computed `position: sticky` at desktop width, total due on delivery `$299.98`, all ten delivery fields present |
| Responsive | no page scrolls sideways at 390 px, 768 px or 1366 px, across catalog, detail, cart and checkout |

The browser added items to a cart and loaded the checkout page; it never submitted the form, so **no
order was created** — the order count is unchanged (below).

### Orders

**Two orders reached Shopify successfully; two were refused by Shopify before anything was created
there; and manual storefront testing can add further orders that sit in `PENDING_SYNC` until the
worker runs.** Shopify holds exactly **2** orders, each matching one local `SYNCED` order
one-to-one, both `PENDING` / unpaid, which is correct for cash on delivery — plus 12 unused drafts
from the §4 debugging.

The `SYNCED` and `FAILED` counts below are stable facts. The local *total* is not: it rises with
every manual test checkout, and a `PENDING_SYNC` row is transient by design — it is the outbox, and
the next worker run resolves it to `SYNCED` or `FAILED`. At the time of writing there are five local
orders, the fifth being one such manual test placed while the worker was stopped.

| | Origin | Outcome | Evidence of origin | Catalog it exercised |
|---|---|---|---|---|
| Order 1 | **Phase 5 verification** — the controlled test described in §4 | `SYNCED` | idempotency key matches this project's verification-script pattern; customer details are the synthetic fixture; 6 attempts, which is the record of the bugs that run exposed | the old Shopify seed catalog |
| Order 2 | **Manual UI checkout** through the storefront | `SYNCED` | browser-minted UUID key from `CheckoutForm`; customer details are **not** the fixture; 1 attempt | the **electronics** catalog |
| Orders 3–4 | **Manual UI checkouts**, 2026-09-30 | `FAILED`, `failureReason = draft_create_user_error` | browser-minted UUID keys; 1 attempt each | the **electronics** catalog (at its pre-respec prices) |
| Order 5 | **Manual UI checkout**, 2026-10-01, placed after the phone fix shipped | `PENDING_SYNC` — the worker was stopped, so it has not been submitted | browser-minted UUID key | the **electronics** catalog |

Orders 3 and 4 are worth reading rather than skipping, because they are the permanent-failure path
working exactly as designed:

- `draftOrderCreate` returned the userError **`phone: Phone is invalid`** for both.
- That is classified **permanent**, not retryable: the same phone number would be refused on every
  retry, so retrying would burn five attempts to reach the same answer.
- `shopifyDraftOrderId` and `shopifyOrderId` are both null on each, confirmed against Shopify — **no
  draft and no order was created**, so nothing is stranded and nothing needs cleaning up.
- Each has `attempt = 1` and one `JobLog` row reading `PENDING_SYNC -> FAILED, retryable = false`.

These two orders are what prompted the phone-validation fix. The checkout used to require only a
*non-empty* phone number, on the reasoning that formats vary by country and the courier is the real
validator. The courier is not the first validator — Shopify is — so the rule now runs **before** the
local order is created:

| Claim | Evidence |
|---|---|
| Phone format is validated server-side before the write | `customerPhone` in `checkout.schema.ts` normalises to E.164 and fails the parse otherwise, so `placeOrder` returns `validation_failed` at step 1, before the idempotency lookup, the variant re-read, the transaction or the enqueue |
| Nothing is written or queued when it fails | integration tests assert `order.count() === 0`, `orderItem.count() === 0`, the injected enqueuer uncalled, and the **real BullMQ** queue's job counts unchanged |
| The rule is calibrated against reality, not taste | the validator accepts both numbers Shopify accepted and rejects both it refused — all four shapes this store has actually seen (`tests/unit/phone.test.ts`) |
| It stays practical internationally | `+` or the ITU `00` prefix, any human separators, 7–15 digits per E.164; no numbering-plan database, because wrong guesses there would reject real customers |
| The shopper can act on the error | the message always names a valid example, and it is keyed `customerPhone` so the form renders it on the field |
| The full phone number is never logged | the validator logs nothing; the service logs only an issue **count**, and `customerPhone` is in `REDACT_PATHS` |

What remains open is the **visibility** half: an order that fails permanently for any other reason
still has no admin UI (**D4**). These two `FAILED` orders were left exactly as they are.

So the electronics catalog has its own end-to-end evidence, which §4 cannot provide: §4's test ran
against a seed-catalog product.

None was created accidentally. No verification script has issued a checkout request since §4: the
§5b browser run loaded the checkout page but never submitted it, and the three orders the phone
verification did place were deleted afterwards along with their queued jobs, behind a guard that
refused to touch any order carrying a Shopify id or a non-fixture name. No order was placed during
the catalog migration or the variant cleanup.

Order 5 is worth one line of its own, because it is unplanned evidence: it is a real human checkout
through the storefront, placed **after** the phone validation shipped, and its phone number is
stored in exact E.164 form (`+` followed by 12 digits, no separators). The new rule therefore
accepts a genuine order rather than blocking one — which a passing test suite alone cannot show.

Shopify also holds **12 draft orders** left by the Phase 5 debugging described in §4. Each is an
unused draft, not an order: nothing was charged and nothing will ship. There is no sweep for them
(**D5**).

Order identifiers, references, idempotency keys and customer details are deliberately not
reproduced here; the orders are described by origin, product, amount and status only.

## 5c. Production deployment on Railway

The app runs on Railway (project `precious-smile`, service `marketplace`) against a MySQL service in
a separate project, reached over a public TCP proxy. That topology is what produced the one
production-only bug in this project, so it is recorded with its measurements.

| Claim | Evidence |
|---|---|
| Migrations applied to the production database | `prisma migrate deploy` applied all four; `prisma migrate status` then reports *Database schema is up to date!* |
| Production catalog populated by the real sync | 10 storefront-visible products, 19 active variants, 27 product rows including archived, 32 `ProductImage` rows, 8 variant-to-image mappings |
| A full sync completes | run at 15:16 UTC: `productsApplied = 10`, `variantsUpserted = 19`, `pagesProcessed = 1`, `finalised = COMPLETED` |
| The live storefront serves it | `GET /` returns 200 with the *Featured Electronics* heading, a rendered count of "10 products", all 10 handles, 10 distinct titles, and 8 *In stock* + 2 *Sold Out* badges |

### The transaction budget, and why it only failed in production

The page write transaction is a few hundred **sequential** statements, so its duration is set by
round-trip latency rather than by server work. Measured per statement: **~1 ms** on a local socket,
**~370 ms** (p95 711 ms) against the production database through the proxy — a cold connect is 3.3 s.

A 27-product page is ~280 statements: under a second locally, **~103 s** remotely. The hard-coded
60 s budget was therefore ample in every local and integration run and expired in production. Once
Prisma closes a timed-out transaction it rejects the next statement with *"Transaction not found"*,
which surfaced inside `reconcileImages()` — not the faulty call, merely where the clock ran out.

Recorded in the production `sync_runs` table, before and after:

| Started (UTC) | Status | Duration | Applied | Variants |
|---|---|---|---|---|
| 14:46 | `PARTIAL` | 368 s | 0 | 0 — `page 0 exhausted 5 attempts: Invalid db.productImage.delet…` |
| 15:11 | `COMPLETED` | 234.8 s | 27 | 45 |
| 15:16 | `COMPLETED` | 116.5 s | 10 | 19 |

The 235 s page is the proof: it could not have committed under the old 60 s budget.

The fix is two coupled numbers, not one. `SYNC_PAGE_TRANSACTION_TIMEOUT_MS` (default 240 000) sizes
the budget for remote latency, and the BullMQ job lock is **derived** from it
(`workerLockDurationMs`, `max(120s, budget + 60s)`). Raising the budget alone would let a slow but
healthy page outlive its lock, so BullMQ would declare it stalled and re-deliver it — a page written
twice instead of a clean failure. Deriving the lock means the two cannot be configured into
disagreement. Since the fix: zero *"Transaction not found"* and zero stalled jobs.

Production also sets **`SHOPIFY_PRODUCTS_PER_PAGE=10`**, which is the better lever: it shortens each
transaction to ~110 statements (~41 s, ~199 s of headroom) with the same per-page atomicity, rather
than relying on a long-held transaction. Atomicity, variant reconciliation, image reconciliation,
the variant-image mapping, the incomplete-pagination gate and the final sweep are all unchanged — the
fix changed two timeouts and nothing else.

### Both processes in one service

The architecture requires the worker to be a separate **process** from Next (§2); it does not
require a separate host service. A Railway trial cannot provision a second service, so one service
supervises both via `scripts/start-production.mjs`, started with `npm run start:production`.

`next start & npm run worker` would not do: the shell becomes PID 1 and forwards no signals, so a
deploy's SIGTERM never reaches the worker and its in-flight jobs lose their lock instead of being
released; and a shell reports its own exit status, so a dead worker would leave the web process
serving while orders silently accumulate in `PENDING_SYNC`. The launcher instead forwards signals to
each child's whole process **group** (`npm run worker` is npm spawning node, so signalling npm alone
would orphan the worker), treats either child's unexpected exit -- including a clean one -- as a
service failure, and exits non-zero so Railway restarts.

`tsx` moved from `devDependencies` to `dependencies` as part of this: the worker starts with
`node --import tsx` and resolves `@/src/...` path aliases that only tsx provides, and a production
install omits devDependencies. Its placement was only ever correct while the worker never ran in
production.

### Not yet in production

- **Nothing drains the outbox if the worker is down.** The launcher makes that loud rather than
  silent -- a dead worker takes the service down and Railway restarts it -- but a persistent worker
  failure still means orders sit in `PENDING_SYNC` until it recovers.
- **Repeatable sync schedulers are registered in the production Redis**, so any worker that connects
  begins syncing every 15 minutes. The manual `FULL` trigger issued during this verification
  correctly reported `sync_skipped: already_running`, which is the database lock doing its job.
- **MySQL is publicly reachable** through the TCP proxy, which is what makes the cross-project
  connection possible. It is password-protected, and public egress is billable.

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
