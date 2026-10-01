"use client";

/**
 * The COD checkout form.
 *
 * What it sends: the cart's variant ids and quantities, the contact and delivery
 * fields, and an idempotency key. What it does NOT send: any price, subtotal or
 * total. The request schema has no field for one (`checkout.schema.ts` is
 * `.strict()`), so a price added here would be rejected by the server rather than
 * quietly ignored.
 *
 * The totals shown come from `/api/cart/hydrate` and are a PREVIEW. The server
 * re-reads every variant when the order is placed, so the authoritative number is
 * the one on the confirmation page. Normally they agree; when the catalog changed
 * mid-checkout they do not, and the server's answer wins.
 *
 * Validation is duplicated here and on the server on purpose: this copy exists to
 * spare a round trip, and the server's copy is the one that decides.
 */
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { describeProblem, type LineProblem } from "@/src/lib/cart/cart-view";
import { formatMoney } from "@/src/lib/money";
import { normalizePhone } from "@/src/lib/phone";
import { serializeCart } from "@/src/lib/cart/cart-state";

import { useCart } from "@/src/components/cart/CartProvider";
import { useHydratedCart } from "@/src/components/cart/useHydratedCart";

/**
 * A short list rather than all 249 ISO codes: this store delivers by courier, and
 * a select is a better control than a free-text field for a value the database
 * stores as CHAR(2).
 */
const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "PK", name: "Pakistan" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "IN", name: "India" },
  { code: "BD", name: "Bangladesh" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
];

interface FormState {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  province: string;
  postalCode: string;
  countryCode: string;
  customerNote: string;
}

const EMPTY_FORM: FormState = {
  customerName: "",
  customerPhone: "",
  customerEmail: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  province: "",
  postalCode: "",
  countryCode: "PK",
  customerNote: "",
};

type Submission =
  | { state: "editing" }
  | { state: "submitting" }
  | { state: "failed"; message: string }
  | { state: "stale"; lineErrors: Array<{ variantId: string; problem: LineProblem }> };

/** Unique per checkout attempt. `randomUUID` needs a secure context; plain http
 *  over a LAN is not one, so there is a fallback. */
function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function CheckoutForm() {
  const router = useRouter();
  const { cart, ready, clear } = useCart();
  const { hydrated, status } = useHydratedCart(cart, ready);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submission, setSubmission] = useState<Submission>({ state: "editing" });

  const cartSignature = useMemo(() => serializeCart(cart), [cart]);

  /**
   * The idempotency key, minted lazily and kept for as long as the cart is
   * unchanged.
   *
   * Stable within one attempt: that is what makes a double-clicked button, a
   * retried request or a lost response safe -- the server recognises the second
   * request as the first one and returns the same order rather than placing
   * another.
   *
   * New when the cart changes: the key is bound to the request that created the
   * order (`requestFingerprint`), so carrying one across an edited cart would
   * guarantee a 409 instead of placing the order the shopper now wants.
   *
   * A ref read in the submit handler, not state set in an effect: nothing renders
   * this value, so state would buy an extra render and a React 19 lint error for
   * no benefit.
   */
  const keyRef = useRef<{ signature: string; key: string } | null>(null);
  function idempotencyKeyForCurrentCart(): string {
    if (keyRef.current?.signature !== cartSignature) {
      keyRef.current = { signature: cartSignature, key: newIdempotencyKey() };
    }
    return keyRef.current.key;
  }

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /** Mirrors the server's required fields, no more. The server re-checks all of them. */
  function localErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (form.customerName.trim().length === 0) errors.customerName = "Name is required";
    // The same function the schema runs, so the two cannot disagree about what a
    // valid number is. This copy only saves a round trip; the server still
    // decides, and it re-validates whatever arrives.
    const phone = normalizePhone(form.customerPhone);
    if (!phone.ok) errors.customerPhone = phone.message;
    if (form.addressLine1.trim().length === 0) errors.addressLine1 = "Address is required";
    if (form.city.trim().length === 0) errors.city = "City is required";
    if (form.countryCode.trim().length !== 2) errors.countryCode = "Select a country";
    return errors;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const errors = localErrors();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmission({ state: "submitting" });

    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKeyForCurrentCart(),
          // Ids and quantities only. No price field exists to send.
          items: cart.lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
          customerName: form.customerName,
          customerPhone: form.customerPhone,
          customerEmail: form.customerEmail || undefined,
          addressLine1: form.addressLine1,
          addressLine2: form.addressLine2 || undefined,
          city: form.city,
          province: form.province || undefined,
          postalCode: form.postalCode || undefined,
          countryCode: form.countryCode,
          customerNote: form.customerNote || undefined,
        }),
      });

      const data: unknown = await response.json().catch(() => null);

      if (response.ok) {
        const confirmationUrl = (data as { confirmationUrl?: string } | null)?.confirmationUrl;
        if (!confirmationUrl) {
          setSubmission({ state: "failed", message: "The order was placed but could not be shown." });
          return;
        }
        // Clear only after the server confirmed. Clearing optimistically loses
        // the cart when the request fails.
        clear();
        router.push(confirmationUrl);
        return;
      }

      const payload = data as
        | {
            error?: string;
            fieldErrors?: Record<string, string>;
            lineErrors?: Array<{ variantId: string; problem: LineProblem }>;
          }
        | null;

      if (payload?.error === "validation_failed" && payload.fieldErrors) {
        setFieldErrors(payload.fieldErrors);
        setSubmission({ state: "editing" });
        return;
      }

      if (payload?.error === "cart_invalid") {
        setSubmission({ state: "stale", lineErrors: payload.lineErrors ?? [] });
        return;
      }

      if (payload?.error === "idempotency_conflict") {
        // This key already belongs to a different order. Rather than silently
        // minting a new one -- which would place a second order -- say so and let
        // the shopper decide.
        setSubmission({
          state: "failed",
          message:
            "An order was already placed with these details. Check your inbox or reload this page to start a new order.",
        });
        return;
      }

      setSubmission({
        state: "failed",
        message: "The order could not be placed. Please try again in a moment.",
      });
    } catch {
      setSubmission({
        state: "failed",
        message: "The order could not be placed -- the connection failed. Please try again.",
      });
    }
  }

  if (!ready || (status === "loading" && hydrated.lines.length === 0)) {
    return <p className="text-muted">Loading your cart…</p>;
  }

  if (cart.lines.length === 0) {
    return (
      <div className="card storefront-card">
        <div className="card-body text-center py-5">
          <h2 className="h5">Nothing to check out</h2>
          <p className="text-muted">Your cart is empty.</p>
          <Link className="btn btn-primary" href="/">
            Continue Shopping
          </Link>
        </div>
      </div>
    );
  }

  const blocked = hydrated.lines.filter((line) => line.problem !== null);
  const submitting = submission.state === "submitting";
  const canSubmit = hydrated.checkoutable && !submitting;

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="row">
        <div className="col-lg-7 mb-4 mb-lg-0">
          <div className="card storefront-card">
            <div className="card-header">
              <h3 className="card-title">Delivery details</h3>
            </div>
            <div className="card-body">
              <div className="form-row">
                <Field
                  className="col-md-6"
                  id="customerName"
                  label="Full name"
                  required
                  value={form.customerName}
                  error={fieldErrors.customerName}
                  autoComplete="name"
                  onChange={(value) => set("customerName", value)}
                />
                <Field
                  className="col-md-6"
                  id="customerPhone"
                  label="Phone number"
                  required
                  value={form.customerPhone}
                  error={fieldErrors.customerPhone}
                  autoComplete="tel"
                  hint="The courier calls this number. Include your country code, e.g. +92 300 1234567."
                  onChange={(value) => set("customerPhone", value)}
                />
              </div>

              <Field
                id="customerEmail"
                label="Email (optional)"
                type="email"
                value={form.customerEmail}
                error={fieldErrors.customerEmail}
                autoComplete="email"
                onChange={(value) => set("customerEmail", value)}
              />

              <Field
                id="addressLine1"
                label="Address"
                required
                value={form.addressLine1}
                error={fieldErrors.addressLine1}
                autoComplete="address-line1"
                onChange={(value) => set("addressLine1", value)}
              />

              <Field
                id="addressLine2"
                label="Apartment, suite, etc. (optional)"
                value={form.addressLine2}
                error={fieldErrors.addressLine2}
                autoComplete="address-line2"
                onChange={(value) => set("addressLine2", value)}
              />

              <div className="form-row">
                <Field
                  className="col-md-5"
                  id="city"
                  label="City"
                  required
                  value={form.city}
                  error={fieldErrors.city}
                  autoComplete="address-level2"
                  onChange={(value) => set("city", value)}
                />
                <Field
                  className="col-md-4"
                  id="province"
                  label="Province / state (optional)"
                  value={form.province}
                  error={fieldErrors.province}
                  autoComplete="address-level1"
                  onChange={(value) => set("province", value)}
                />
                <Field
                  className="col-md-3"
                  id="postalCode"
                  label="Postal code (optional)"
                  value={form.postalCode}
                  error={fieldErrors.postalCode}
                  autoComplete="postal-code"
                  onChange={(value) => set("postalCode", value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="countryCode">Country</label>
                <select
                  id="countryCode"
                  className={`form-control${fieldErrors.countryCode ? " is-invalid" : ""}`}
                  value={form.countryCode}
                  autoComplete="country"
                  onChange={(event) => set("countryCode", event.target.value)}
                >
                  {COUNTRIES.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </select>
                {fieldErrors.countryCode ? (
                  <div className="invalid-feedback d-block">{fieldErrors.countryCode}</div>
                ) : null}
              </div>

              <div className="form-group mb-0">
                <label htmlFor="customerNote">Order notes (optional)</label>
                <textarea
                  id="customerNote"
                  className="form-control"
                  rows={3}
                  maxLength={2000}
                  value={form.customerNote}
                  onChange={(event) => set("customerNote", event.target.value)}
                />
                {fieldErrors.customerNote ? (
                  <div className="invalid-feedback d-block">{fieldErrors.customerNote}</div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="card storefront-card mb-0">
            <div className="card-header">
              <h3 className="card-title">Payment</h3>
            </div>
            <div className="card-body">
              {/*
                One method, so this is a statement rather than a choice. A radio
                group with a single option invites a second one to be added in the
                UI before the server knows how to charge for it.
              */}
              <p className="storefront-cod-chip mb-2">Cash on delivery</p>
              <p className="text-muted small mb-0">
                Pay the courier in cash when your order arrives. No card details are collected.
              </p>
            </div>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card storefront-card storefront-sticky">
            <div className="card-header">
              <h3 className="card-title">Your order</h3>
            </div>
            <div className="card-body p-0">
              <table className="table table-sm mb-0">
                <tbody>
                  {hydrated.lines.map((line) => (
                    <tr key={line.variantId} className={line.problem ? "table-warning" : undefined}>
                      <td>
                        <span className="font-weight-bold">{line.productTitle}</span>
                        {line.variantTitle ? (
                          <div className="text-muted small">{line.variantTitle}</div>
                        ) : null}
                        <div className="text-muted small">Qty {line.quantity}</div>
                        {line.problem ? (
                          <div className="text-danger small font-weight-bold">
                            {describeProblem(line.problem)}
                          </div>
                        ) : null}
                      </td>
                      <td className="text-right align-middle">
                        {line.available ? formatMoney(line.lineTotal, line.currencyCode) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body border-top">
              <dl className="row mb-0">
                <dt className="col-7">Subtotal</dt>
                <dd className="col-5 text-right">
                  {formatMoney(hydrated.subtotal, hydrated.currencyCode)}
                </dd>
                <dt className="col-7 text-muted">Shipping</dt>
                <dd className="col-5 text-right text-muted">Free</dd>
                <dt className="col-7 text-muted">Tax</dt>
                <dd className="col-5 text-right text-muted">
                  {formatMoney("0.00", hydrated.currencyCode)}
                </dd>
                <dt className="col-7 storefront-summary-total border-top pt-3 mt-2">
                  Total due on delivery
                </dt>
                <dd className="col-5 text-right storefront-summary-total border-top pt-3 mt-2">
                  {formatMoney(hydrated.subtotal, hydrated.currencyCode)}
                </dd>
              </dl>
            </div>
            <div className="card-footer">
              {blocked.length > 0 ? (
                <div className="alert alert-warning small">
                  Some items can no longer be ordered.{" "}
                  <Link href="/cart">Return to the cart</Link> to fix them.
                </div>
              ) : null}

              {submission.state === "failed" ? (
                <div className="alert alert-danger small">{submission.message}</div>
              ) : null}

              {submission.state === "stale" ? (
                <div className="alert alert-danger small">
                  <p className="mb-1 font-weight-bold">Your cart changed while you were checking out.</p>
                  <p className="mb-0">
                    Nothing was ordered and nothing was charged.{" "}
                    <Link href="/cart">Review your cart</Link> and try again.
                  </p>
                </div>
              ) : null}

              <button
                type="submit"
                className="btn btn-primary btn-block storefront-cta"
                disabled={!canSubmit}
              >
                {submitting ? "Placing your order…" : "Place order"}
              </button>
              <p className="text-muted small mb-0 mt-2">
                Prices and stock are confirmed against the catalog when you place the order.
              </p>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  required,
  type = "text",
  className,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  className?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div className={`form-group${className ? ` ${className}` : ""}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        className={`form-control${error ? " is-invalid" : ""}`}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small className="form-text text-muted">{hint}</small> : null}
      {error ? <div className="invalid-feedback d-block">{error}</div> : null}
    </div>
  );
}
