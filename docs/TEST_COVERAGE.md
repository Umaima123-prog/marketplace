# Test coverage

Measured, not estimated. Every number here came from `npm run test:coverage` and
`npm run test:integration`; nothing is rounded up and nothing is inferred from test names.

## Headline

| Suite | Tests | Files | Statements | Branches | Functions | Lines |
|---|---|---|---|---|---|---|
| Unit (`npm test`) | **333 passed** | 23 | **36.21%** | **35.81%** | **38.98%** | **35.65%** |
| Integration (`npm run test:integration`) | **210 passed** | 7 | **51.47%** | **45.55%** | **53.04%** | **53.30%** |

**543 tests pass in total.** HTML report: `coverage/index.html` (unit),
`coverage/integration/index.html` (integration).

### Read the two numbers together, not separately

Neither figure alone describes this project, and the unit number taken alone is actively
misleading.

The suites cover deliberately different things. The unit suite covers pure logic, mappers, decision
functions and fake-client paths, and it runs with **nothing started** — no MySQL, no Redis, no
Shopify. Everything whose behaviour *is* the database — the checkout write path, the order state
machine, the sync repository, the catalog read path — is covered by the integration suite against
**real MySQL and real Redis**, because a fake database would prove nothing about a `UNIQUE`
constraint, a `DECIMAL(18,4)` round trip, or five concurrent conditional `UPDATE`s.

So `src/server/checkout/checkout.service.ts` reads **0% unit / 97.43% integration**. That is not a
gap; it is the design. Coverage is reported per suite rather than merged for the same reason: a
merged percentage would hide which guarantee each suite actually provides.

Both measurements scope coverage with an explicit `include` over the source tree rather than letting
the test imports decide it, so a source file **no test imports at all** is still measured and still
counts against the totals. The gaps below are therefore real gaps, not artefacts of only measuring
what tests happened to touch.

## Strongest coverage

23 of 49 measured files reach **≥85%** statements in at least one suite.

| File | Unit | Integration |
|---|---|---|
| `src/server/checkout/checkout.schema.ts` | 100% | 100% |
| `src/server/checkout/fingerprint.ts` | 100% | 100% |
| `src/lib/prisma.ts` | 100% | 100% |
| `src/lib/shopify/order-mutations.ts` | 100% | 100% |
| `src/lib/phone.ts` | **100%** | 80% |
| `src/lib/cart/cart-view.ts` | 100% | 72% |
| `src/lib/sync/decisions.ts` | 100% | 42% |
| `src/lib/orders/draft-order-input.ts` | 100% | 86% |
| `src/lib/orders/payment-terms.ts` | 100% | 6% |
| `src/lib/shopify/errors.ts` | 100% | 67% |
| `src/server/cart/cart.service.ts` | — | **100%** |
| `src/lib/cart/cart-state.ts` | 98% | 6% |
| `src/server/checkout/checkout.service.ts` | — | **97.4%** |
| `src/lib/shopify/throttle.ts` | 96.3% | 4% |
| `src/lib/money.ts` | 95.7% | 35% |
| `src/lib/orders/recovery.ts` | — | **95.7%** |
| `src/lib/orders/order-repo.ts` | 3% | **94.4%** |
| `src/worker/processors/submit-order.ts` | 12% | **94.1%** |
| `src/lib/sync/catalog-repo.ts` | 89.9% | 92.8% |
| `src/lib/orders/submit-order.ts` | 10% | **91.9%** |
| `src/lib/logger.ts` | 50% | 87.5% |
| `src/server/catalog/catalog.service.ts` | — | **86.2%** |
| `src/lib/env.ts` | 85.5% | 29% |
| `src/lib/sync/product-mapper.ts` | 85.0% | 64% |
| `src/lib/jobs/job-log.ts` | — | 83.9% |
| `src/lib/sync/sync-run.ts` | — | 80.6% |

By directory, the strongest areas are `src/lib/cart` (98.7% unit), `src/server/checkout` (schema and
fingerprint at 100%, service at 97.4% integration), `src/lib/sync` (76.3% unit / 92.8% on the
repository itself) and `src/lib/orders` (91–95% integration on the three modules that matter).

## What the important areas are covered by

| Area | Where it is covered | Evidence worth knowing |
|---|---|---|
| **Shopify catalog sync** | `product-mapper.ts` 85%, `catalog-repo.ts` 92.8%, `decisions.ts` 100%, `sync-run.ts` 80.6% | Mapper rejects malformed payloads by path; the run lock, heartbeat reclaim and finalisation are tested against real MySQL |
| **Product / variant reconciliation** | `catalog-repo.ts` 92.8% | `deactivateMissingVariants` and `sweepMissingProducts` including the NULL-safe sweep predicate, soft deactivation, and a real `P2002` collision. Variants are never hard-deleted, so order history survives |
| **Variant-specific images** | `tests/unit/variant-image.test.ts` (10 cases) + `catalog-repo` / `catalog` integration | Mapping synced from Shopify, fallback when none assigned, re-running duplicates no image rows (row **ids** asserted stable), the `ON DELETE SET NULL` path when a referenced image is deleted, and that incomplete variant pagination cannot corrupt the mapping |
| **Cart** | `cart-state.ts` 98%, `cart-view.ts` 100%, `cart.service.ts` 100% | A cart **cannot persist a price**: `serializeCart` writes two fields whatever the object holds, and `parseCart` survives bad JSON, an older format, an injected `price` key and 10 000 lines |
| **Checkout** | `checkout.schema.ts` 100%, `checkout.service.ts` 97.4% | The schema has **no money field at all**, so a browser-supplied `price`/`subtotal`/`grandTotal` is rejected rather than silently dropped; totals are Decimal-exact; an unsellable line is refused; `Order` and `OrderItem` appear together or not at all |
| **Phone validation** | `phone.ts` **100%** | Calibrated against reality: the validator accepts both numbers Shopify accepted and rejects both it refused — all four shapes this store has actually seen. Integration asserts a rejected phone creates **no order, no order items and no queued job** |
| **Checkout idempotency** | `fingerprint.ts` 100%, `checkout.service.ts` 97.4% | A fingerprint is stable across harmless formatting differences and changes for every field that matters, including a value moving between adjacent fields. One key yields one order under a **genuine concurrent `P2002` race**; the same key with a different payload is refused, never answered |
| **BullMQ order sync** | `submit-order.ts` 91.9%, `src/worker/processors/submit-order.ts` 94.1%, `order-repo.ts` 94.4%, `draft-order-input.ts` 100%, `shopify-port.ts` 77.8% | Five simultaneous claims produce exactly one claim; the draft id is persisted **before** completion is attempted, asserted from inside a failing completion; a resumed order creates no second draft. `submit-order-queue.integration.test.ts` runs against **BullMQ itself**, because a mock would have reproduced the bug rather than caught it |
| **Recovery** | `recovery.ts` 95.7%, `job-log.ts` 83.9% | The outbox drain: expired claims, the grace window, and `JobLog` recording both attempt 1s when a job is replaced under one fixed job id (the D11 regression) |
| **Production process launcher** | `scripts/start-production.mjs` 8.95% — see below | Configuration is unit-tested (both children, port from the environment, both critical, no secret read, platform spawn options). Lifecycle is verified in the production deploy logs, not mocked |

## Known gaps

Stated plainly. 17 of 49 measured files are at 0% in **both** suites, and they fall into four groups.

**1. React components — 9 files at 0%.** `CartProvider`, `CartView`, `CartBadge`, `useHydratedCart`,
`CheckoutForm`, `Navbar`, `ProductCard`, `ProductPurchasePanel`, `StorefrontLayout`. There is no DOM
test harness (recorded as gaps **C6** and **F4**): no jsdom, no Testing Library. The rules worth
protecting were deliberately kept out of the components and live in pure modules that *are* tested —
`cart-state.ts` (98%), `cart-view.ts` (100%), `phone.ts` (100%).

These are not unverified, they are verified differently: **96 assertions in a real headless Chrome**
over three runs — 58 storefront UX checks, 26 variant-image checks and 12 phone-validation checks —
driving real controls and reading the resulting DOM. That caught two genuine bugs a unit test would
not have (a thumbnail override that survived a variant change, and a stale manual-image rule).

**2. Worker wiring — 6 files at 0%.** `src/worker/index.ts`, `src/worker/scheduler.ts`, and the
`order-recovery`, `product-sync`, `product-sync-page` and `variant-sync` processors. These are thin
BullMQ adapters: they read a job payload, call a library function and log. The logic they call is
well covered — `catalog-repo.ts` 92.8%, `submit-order.ts` 91.9%, `recovery.ts` 95.7%, `job-log.ts`
83.9% — and the one processor with real branching, `submit-order.ts`, is at **94.1%**.

Covering the rest would mean mocking BullMQ, Prisma, Redis and Shopify at once, which tests the
mocks. They are exercised instead by running the real worker: a production sync completing with
`productsApplied = 10`, `variantsUpserted = 19`, `finalised = COMPLETED`.

**3. The production launcher — 8.95%.** Its exported helpers are unit-tested; `main()` is process
orchestration — spawn, signal forwarding to a process group, exit propagation — which cannot be
meaningfully unit-tested without mocking `child_process` into a different program. It is verified
where it runs: the Railway logs show the launcher line, Next.js `Ready`, `worker_starting`,
`sync_schedulers_registered`, `order_recovery_scheduler_registered` and `worker_ready` from one
service, with no child exit. Two real portability bugs in it were found by running it locally.

**4. No executable logic, or test tooling.** `src/lib/shopify/queries.ts` (0%) is GraphQL document
strings. `scripts/prepare-test-db.mjs` (0%) is the integration harness itself.

### Two genuine thin spots

- **`src/lib/shopify/client.ts` — 4.9%.** The HTTP client: retry, backoff, cost pacing and the 401
  re-exchange. Its *classification* logic is fully covered (`errors.ts` 100%, `throttle.ts` 96.3%)
  and the client is exercised constantly against the live API, but the transport itself has no
  automated test. This is the largest honest gap in the codebase.
- **`src/lib/shopify/auth.ts` — 12.3%.** `shopify-auth.test.ts` covers the client-credentials
  exchange, caching and the single 401 re-exchange; the remaining branches are failure paths that
  need a fake HTTP layer.

Both would be addressed the same way: a fetch-level fake for the Shopify transport. That is a
worthwhile next step and is not pretended to exist.

Nothing in this document is a surprise discovered at report time; the component and transport gaps
were recorded in `ARCHITECTURE.md` when the decisions were made.

## Reproducing

```bash
npm run test:coverage      # unit suite + coverage/, prints the summary table
npm run test:integration   # real MySQL + real Redis (needs docker compose up -d)
```

Coverage configuration is in `vitest.config.mts`: provider `v8`, measured scope `src/**` plus
`scripts/*.mjs` via `coverage.include`, with the generated Prisma client excluded.
