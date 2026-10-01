# Submission

A reviewer's guide: what this is, what to run, where to look, and what is deliberately missing.

**Demo video:** <https://www.loom.com/share/02fc3b42859640d9b1428029c730b425>

The walkthrough is the fastest way to see the system working end to end. Everything it shows is
reproducible from this repository — the figures and the flows are recorded in
[VERIFICATION.md](VERIFICATION.md).

## What was built

A Next.js storefront selling a Shopify catalog **cash on delivery**, with MySQL as the
storefront's source of truth and a separate worker process owning every Shopify call.

| Capability | State |
|---|---|
| Background product sync (Shopify → MySQL) | Implemented, verified against a real store |
| Storefront listing and product detail | Implemented, verified |
| Guest cart + COD checkout | Implemented, verified |
| Asynchronous COD order submission (MySQL → Shopify) | Implemented, **two real orders taken end to end**; the permanent-failure path exercised by two more |
| Webhooks | Not built — deliberate scope decision |
| Admin UI | Not built |
| Inventory reservation | Not built — deliberate, documented (C1) |

## Evidence

| Check | Result |
|---|---|
| `npm test` | **302 passed** (20 files) |
| `npm run test:integration` | **197 passed** (7 files, real MySQL + real Redis) |
| `npm run typecheck` | clean |
| `npm run lint` | clean — 0 errors, 0 warnings |
| `npm run build` | clean |
| Real end-to-end Shopify COD orders | **2 verified** — one from the controlled Phase 5 test, one from a manual storefront checkout. Each is `SYNCED` locally with one draft and one Shopify order, `displayFinancialStatus: PENDING` with the full amount outstanding, totals matching to the cent, no duplicates |
| Permanent-failure path | **2 local orders `FAILED`**, both refused by Shopify at draft creation (`phone: Phone is invalid`), correctly classified non-retryable with no draft and no Shopify order created. Their cause is now validated out at the checkout boundary — see [VERIFICATION.md](VERIFICATION.md) §5a |
| Storefront UX | **58 checks** in a real headless browser: variant switching, sold-out states, quantity caps, cart, checkout and three viewport widths (VERIFICATION.md §5b) |
| Demo video | <https://www.loom.com/share/02fc3b42859640d9b1428029c730b425> |

Details, including what was *not* verified live, are in [VERIFICATION.md](VERIFICATION.md).

## Running it

```bash
npm install
cp .env.example .env          # fill in; it is gitignored
docker compose up -d          # MySQL 8.4 + Redis 7
npx prisma migrate deploy
npx prisma generate

npm run dev                   # storefront on :3000
npm run worker                # in a second terminal: the worker process
```

The storefront and the whole test suite run **without** Shopify credentials. They are needed only
to sync a catalog or submit an order. Full setup, including the five Shopify scopes and the
protected-customer-data requirement, is in the [README](../README.md).

## Where to look

If you have ten minutes, these are the files where the design actually lives.

| Question | File |
|---|---|
| How is the whole thing meant to work? | [`ARCHITECTURE.md`](../ARCHITECTURE.md) — the authoritative design, with every known gap |
| Why can't the browser change a price? | `src/server/checkout/checkout.schema.ts` (no money field exists), `src/server/checkout/checkout.service.ts` (re-reads MySQL) |
| How is double-ordering prevented? | `src/server/checkout/fingerprint.ts`, and `src/lib/orders/order-repo.ts` for the conditional-update state machine |
| How is a lost Shopify response handled? | `src/lib/orders/submit-order.ts` — the two-phase draft with a durable checkpoint |
| What decides retry vs give up? | `src/lib/shopify/errors.ts`, `src/lib/orders/shopify-port.ts` |
| How does money stay exact? | `src/lib/money.ts`, and the `CHECK` constraints in `prisma/migrations/20260929053009_init/migration.sql` |
| What stops the storefront calling Shopify? | `src/server/catalog/catalog.service.ts` — `server-only`, so a violation is a build error |

The commit history is phase-by-phase and each message explains the decisions in that phase:

```
15d4ab0 fix: cascade product status to synced variants
365de98 docs: add project README and submission documentation
8460f63 feat: add asynchronous Shopify COD order sync
66f3cd3 feat: add cart and COD checkout flow
6492a79 feat: add MySQL-backed storefront catalog
c9c9318 fix: harden Shopify auth and live sync verification
0373898 feat: add background Shopify product sync pipeline
8c15d13 chore: add database and local infrastructure foundation
```

The electronics catalog that the storefront now serves required **no commit**: the products were
created in Shopify and arrived through the existing sync. `15d4ab0` came out of that exercise — it
fixes a sync bug archiving the old catalog exposed.

## Design decisions worth defending

Short list; the reasoning is in `ARCHITECTURE.md`.

- **Two processes, not one.** The web process is a producer only and never constructs a BullMQ
  `Worker`. A sync that runs inside a page request ties catalog freshness to whoever happens to
  load a page, holds a request open for minutes, and dies when the invocation does.
- **The `Order` row is the outbox.** No separate outbox table: it would be 1:1 with the order,
  carry one event type, and add a whole class of "outbox says SENT / order says PENDING"
  divergence for nothing. `status = PENDING_SYNC` means "needs submitting", and a recovery sweep
  drains it.
- **Every guarantee is a database constraint, not a queue feature.** BullMQ deduplication is
  layer zero. Wipe Redis and re-enqueue every order from cold: nothing duplicates, because
  `idempotencyKey`, `submissionKey`, `shopifyDraftOrderId` and `shopifyOrderId` are unique and
  every state transition is a conditional `UPDATE`.
- **A stranded draft is garbage; a duplicated order is a second parcel.** All the uncertainty is
  pushed into phase 1 of submission, where a mistake is cheap and sweepable, so phase 2 is keyed by
  an id already stored locally.
- **Money is never a float.** `DECIMAL(18,4)`, `Prisma.Decimal`, exact strings on the wire, and
  `CHECK` constraints so a bug in application code cannot persist incoherent totals.
- **Soft deactivation only.** Nothing in the catalog is hard-deleted, so a bad sync degrades
  visibility rather than destroying history.
- **API field names were read from the schema, not from memory.** Introspecting the pinned API
  version found three wrong assumptions before they shipped, including one that would have sent
  Shopify the *current catalog price* instead of the price the customer was quoted.

## Known gaps

Full list with reasoning in `ARCHITECTURE.md` (§3.7 S1–S8, §3a.1 F1–F6, §4.1c C1–C8, §4.2c D3–D12).
The ones a reviewer should weigh:

| Gap | Summary |
|---|---|
| **C1** | **No inventory reservation.** Stock is validated server-side at checkout but not reserved, so two simultaneous checkouts for the last unit can both succeed. The largest known correctness gap, and deliberate: a half-built reservation counter that silently drifts is worse than a documented race. A real implementation is a subsystem with its own lifecycle and reconciliation. |
| **D10** | **COD uses a deprecated argument.** `draftOrderComplete(paymentPending: true)`, because `paymentTerms` — the documented replacement — is refused for this app. Both paths are implemented; migrating is one setting once the permission is granted. |
| **D4, D5** | No admin UI for `FAILED` orders, and no sweep for drafts stranded by a permanent failure. Two such orders exist and are invisible to everyone: the shopper saw a confirmation page, and nothing surfaces that Shopify refused the order. The *cause* of those two is fixed — phone format is now validated and normalised to E.164 before the order is created — but the visibility gap is not. |
| **S2** | Shopify cost pacing is process-local, so a second worker process would over-request. |
| **S8, F5** | The >100-variant chain and production-size keyset pagination have never run against live data — the development store is too small. Automated tests only. |
| **F6** | Publication state is not synced: a product `ACTIVE` in Shopify but unpublished from the Online Store channel is still listed. Documented as a scope decision rather than patched with a storefront filter that would disagree with the data it reads. |
| **C4, C5** | No rate limit on checkout; no retention or erasure policy for order PII. |
| **C6, F4** | No UI component tests and no DOM harness. The rules worth protecting live in pure modules and services, which are tested directly. |
| **D8** | BullMQ's 120s stall timer is shorter than the 300s database lease, so a dead worker's order waits for the recovery sweep. Bounded; never a duplicate. |

Nothing in this list is a surprise discovered at submission time; each was recorded when the
decision was made.

## Repository safety

| Confirmation | Status |
|---|---|
| `.env` is gitignored and untracked | ✅ `.gitignore:34` (`.env*`); absent from every commit |
| Generated Prisma client not committed | ✅ `.gitignore:45` (`/src/generated/`) |
| No Shopify credentials committed | ✅ no access token, client secret or admin token anywhere in the tree |
| No database passwords committed | ✅ `.env.example` holds `REPLACE_ME` placeholders; test configs use deliberate `test:test` / `unused:unused` values |
| No customer PII committed | ✅ the only email is `ayesha@example.com` (RFC 2606 reserved); phone numbers are the dummy `+92 300 1234567` pattern. Both are unit-test fixtures |
| No live order data committed | ✅ no order reference, public token, draft id or Shopify order id appears in the repository |
| Secrets never logged | ✅ the access token exists as a local variable and one request header. `REDACT_PATHS` in `src/lib/logger.ts` is the backstop, covering tokens, secrets, passwords and every customer field including city and postal code |
| Order URLs not enumerable | ✅ the confirmation page is addressed by a 32-byte random token, never by the short customer-facing reference |

Every order discussed here lives on a **development store**. The controlled Phase 5 order used
synthetic data explicitly marked as a test.

## AI and tooling disclosure

This project was built by a developer working with **Claude (Anthropic)** as a coding assistant,
in an agentic setup where the assistant proposed and wrote code, ran commands, and read command
output directly.

How that worked in practice, stated plainly:

- **The work was directed phase by phase.** The developer set the scope and constraints of each
  phase, reviewed the result, and approved each commit. Every commit message was written to
  explain decisions rather than to list changes.
- **Claims in this repository were verified by running things, not asserted.** Test counts come
  from the test runner. The live-order evidence comes from querying MySQL and the Shopify Admin API
  after the fact. Where something could not be verified, `VERIFICATION.md` §6 says so.
- **API behaviour was read from the API.** The Shopify mutations were written against an
  introspection of the pinned version, and the draft-order input was validated with
  `draftOrderCalculate` (which prices a draft without creating one). Three field-name assumptions
  turned out to be wrong and were corrected before shipping.
- **Several bugs were found only by running against the real service**, and they are documented in
  `VERIFICATION.md` §4 rather than quietly fixed — including a BullMQ argument-order mistake and a
  silently-swallowed error in the recovery path.

Other tooling: Docker for MySQL and Redis, Prisma for migrations and the client, Vitest for tests,
ESLint and the TypeScript compiler for static checks.
