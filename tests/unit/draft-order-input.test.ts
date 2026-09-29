/**
 * Order rows -> DraftOrderInput.
 *
 * This mapping decides two things that matter more than the rest of the worker:
 * what price Shopify records, and what customer data leaves this system. The
 * price must come from the OrderItem snapshot -- the number the customer was
 * quoted and the courier will collect -- and not from the variant's current
 * catalog price, which Shopify would otherwise use.
 *
 * Field names were confirmed by introspecting API version 2026-07; three of the
 * obvious guesses are wrong there, so the shape is asserted here to catch a
 * well-meaning "simplification" later.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_TAG_LENGTH,
  submissionTag,
  submissionTagQuery,
} from "@/src/lib/shopify/order-mutations";

import {
  buildDraftOrderInput,
  COD_SHIPPING_TITLE,
  COD_TAG,
  splitName,
  type DraftOrderSource,
} from "@/src/lib/orders/draft-order-input";

function source(overrides: Partial<DraftOrderSource> = {}): DraftOrderSource {
  return {
    reference: "COD-ABC123",
    submissionKey: "0d9f1c3e-8b7a-4e21-9f0a-2c5d7e8f1a2b",
    currencyCode: "USD",
    customerName: "Ayesha Khan",
    customerPhone: "+92 300 1234567",
    customerEmail: "ayesha@example.com",
    addressLine1: "12 Jinnah Road",
    addressLine2: "Flat 4",
    city: "Lahore",
    province: "Punjab",
    postalCode: "54000",
    countryCode: "PK",
    customerNote: "Call on arrival",
    items: [
      { shopifyVariantId: "gid://shopify/ProductVariant/1", quantity: 2, unitPrice: "19.99" },
      { shopifyVariantId: "gid://shopify/ProductVariant/2", quantity: 1, unitPrice: "1000.5000" },
    ],
    ...overrides,
  };
}

describe("splitName", () => {
  it("splits a two-part name", () => {
    expect(splitName("Ayesha Khan")).toEqual({ firstName: "Ayesha", lastName: "Khan" });
  });

  it("keeps a multi-part surname whole", () => {
    expect(splitName("Maria del Carmen Garcia")).toEqual({
      firstName: "Maria",
      lastName: "del Carmen Garcia",
    });
  });

  it("handles a single name without inventing a surname", () => {
    expect(splitName("Prince")).toEqual({ firstName: "Prince" });
  });

  it("collapses odd whitespace", () => {
    expect(splitName("  Ayesha   Khan  ")).toEqual({ firstName: "Ayesha", lastName: "Khan" });
  });

  it("falls back rather than producing an empty first name", () => {
    expect(splitName("   ")).toEqual({ firstName: "Customer" });
  });
});

describe("buildDraftOrderInput: prices come from the snapshot", () => {
  it("sends priceOverride for every line, from the order item", () => {
    // priceOverride is the field that works for a VARIANT line item.
    // originalUnitPrice and originalUnitPriceWithCurrency are documented as
    // "ignored when variantId is provided" -- using one of those would silently
    // hand Shopify the catalog price instead.
    const input = buildDraftOrderInput(source());

    expect(input.lineItems).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/1",
        quantity: 2,
        priceOverride: { amount: "19.99", currencyCode: "USD" },
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        quantity: 1,
        priceOverride: { amount: "1000.5000", currencyCode: "USD" },
      },
    ]);
  });

  it("passes the price through as an exact string, never a number", () => {
    const input = buildDraftOrderInput(source());
    for (const line of input.lineItems) {
      expect(typeof line.priceOverride.amount).toBe("string");
    }
    // A four-decimal amount survives intact; JSON.parse(JSON.stringify(...)) of a
    // float would not.
    expect(input.lineItems[1].priceOverride.amount).toBe("1000.5000");
  });

  it("uses the order's currency on every amount", () => {
    const input = buildDraftOrderInput(source({ currencyCode: "PKR" }));
    expect(input.shippingLine.priceWithCurrency.currencyCode).toBe("PKR");
    expect(input.lineItems.every((l) => l.priceOverride.currencyCode === "PKR")).toBe(true);
  });
});

describe("buildDraftOrderInput: COD semantics", () => {
  it("adds a zero shipping line using priceWithCurrency", () => {
    // ShippingLineInput.price is deprecated in favour of priceWithCurrency.
    const input = buildDraftOrderInput(source());
    expect(input.shippingLine).toEqual({
      title: COD_SHIPPING_TITLE,
      priceWithCurrency: { amount: "0.00", currencyCode: "USD" },
    });
  });

  it("marks the draft tax exempt, because tax is zero locally", () => {
    // Without this Shopify would add its own tax and record a total the customer
    // never agreed to and the courier would not collect.
    expect(buildDraftOrderInput(source()).taxExempt).toBe(true);
  });

  it("sets payment terms when a template is available", () => {
    const input = buildDraftOrderInput(source(), { paymentTermsTemplateId: "gid://x/1" });
    expect(input.paymentTerms).toEqual({ paymentTermsTemplateId: "gid://x/1" });
  });

  it("omits payment terms entirely when no template was found", () => {
    // A draft with no terms is still a correct unpaid draft. Sending
    // `paymentTerms: undefined` explicitly would be a different thing to debug.
    const input = buildDraftOrderInput(source());
    expect(input.paymentTerms).toBeUndefined();
    expect("paymentTerms" in input).toBe(false);
  });

  it("tags the draft for recovery and states COD", () => {
    const input = buildDraftOrderInput(source());
    expect(input.tags).toContain(COD_TAG);
    // Derived, not a literal: the tag is compacted to stay inside Shopify's
    // 40-character limit, and the search side derives it the same way. Asserting
    // a hand-written string here is what let the two drift apart in the first
    // place.
    expect(input.tags).toContain(submissionTag("0d9f1c3e-8b7a-4e21-9f0a-2c5d7e8f1a2b"));
    expect(input.tags).toContain("cod-0d9f1c3e8b7a4e219f0a2c5d7e8f1a2b");
  });

  it("carries the submission key as a custom attribute as well as a tag", () => {
    // The tag is searchable, which is what the lost-response pre-flight needs;
    // the attribute survives a merchant editing tags in the admin.
    const input = buildDraftOrderInput(source());
    expect(input.customAttributes).toEqual([
      { key: "submissionKey", value: "0d9f1c3e-8b7a-4e21-9f0a-2c5d7e8f1a2b" },
      { key: "codReference", value: "COD-ABC123" },
    ]);
  });
});

describe("buildDraftOrderInput: the address", () => {
  it("sends the structured address Shopify accepts", () => {
    const input = buildDraftOrderInput(source());
    expect(input.shippingAddress).toEqual({
      firstName: "Ayesha",
      lastName: "Khan",
      address1: "12 Jinnah Road",
      address2: "Flat 4",
      city: "Lahore",
      zip: "54000",
      countryCode: "PK",
      phone: "+92 300 1234567",
    });
  });

  it("never sends the province as provinceCode", () => {
    // MailingAddressInput on 2026-07 has provinceCode and no free-text province.
    // "Punjab" is a name, not a code: sending it would be refused or, worse,
    // resolved to somewhere else.
    const input = buildDraftOrderInput(source());
    expect(input.shippingAddress).not.toHaveProperty("provinceCode");
    expect(input.shippingAddress).not.toHaveProperty("province");
    // Preserved where a human packing the parcel will see it.
    expect(input.note).toContain("Punjab");
  });

  it("omits optional address parts rather than sending empty strings", () => {
    const input = buildDraftOrderInput(
      source({ addressLine2: null, postalCode: null, customerEmail: null }),
    );
    expect("address2" in input.shippingAddress).toBe(false);
    expect("zip" in input.shippingAddress).toBe(false);
    expect("email" in input).toBe(false);
  });

  it("includes the email only when there is one", () => {
    expect(buildDraftOrderInput(source()).email).toBe("ayesha@example.com");
  });
});

describe("buildDraftOrderInput: the note", () => {
  it("states cash on delivery and the reference", () => {
    const note = buildDraftOrderInput(source()).note;
    expect(note).toContain("Cash on Delivery");
    expect(note).toContain("COD-ABC123");
    expect(note).toContain("USD");
  });

  it("includes the customer's own note", () => {
    expect(buildDraftOrderInput(source()).note).toContain("Call on arrival");
  });

  it("omits the lines it has no value for", () => {
    const note = buildDraftOrderInput(source({ province: null, customerNote: null })).note;
    expect(note).not.toContain("Province");
    expect(note).not.toContain("Customer note");
  });
});

describe("buildDraftOrderInput: what is NOT sent", () => {
  it("sends no local ids, totals or status", () => {
    // Shopify computes the totals from the lines it was given. Sending ours would
    // create two numbers that can disagree, and the local row is the one that
    // governs what the courier collects.
    const serialised = JSON.stringify(buildDraftOrderInput(source()));
    for (const forbidden of ["subtotal", "grandTotal", "taxTotal", "idempotencyKey", "publicToken", "PENDING_SYNC"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("does not send a customer id or create a customer account", () => {
    const input = buildDraftOrderInput(source());
    expect(input).not.toHaveProperty("customerId");
    expect(input).not.toHaveProperty("purchasingEntity");
  });
});

describe("submissionTag: Shopify's 40-character tag limit", () => {
  it("keeps a real submission key's tag inside the limit", () => {
    // The bug this guards: `cod-` + a 36-character randomUUID() is EXACTLY 40,
    // so the original form sat on the limit with no margin at all. Shopify
    // rejects an over-long tag as a userError, which this project treats as
    // PERMANENT -- so one extra character would have failed every order,
    // immediately and unretryably.
    const key = randomUUID();
    const tag = submissionTag(key);
    expect(tag.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    expect(tag.length).toBeLessThan(MAX_TAG_LENGTH); // margin, not just compliance
  });

  it("stays inside the limit for any key the column can hold", () => {
    // submissionKey is VARCHAR(64). A 64-character key must not produce a 68
    // character tag.
    for (const key of ["x".repeat(64), "a-b-c-".repeat(10), randomUUID() + randomUUID()]) {
      expect(submissionTag(key).length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    }
  });

  it("is stable, so the writer and the tag search always agree", () => {
    const key = randomUUID();
    expect(submissionTag(key)).toBe(submissionTag(key));
    expect(submissionTagQuery(key)).toBe(`tag:"${submissionTag(key)}"`);
  });

  it("distinguishes different keys", () => {
    expect(submissionTag(randomUUID())).not.toBe(submissionTag(randomUUID()));
  });

  it("quotes the query, because an unquoted hyphen means negation in Shopify search", () => {
    // `tag:cod-abc` unquoted would parse as "tagged cod, not abc" and silently
    // find nothing -- which would disable the lost-response recovery entirely.
    const query = submissionTagQuery(randomUUID());
    expect(query.startsWith('tag:"')).toBe(true);
    expect(query.endsWith('"')).toBe(true);
  });

  it("carries no character that needs escaping in a search query", () => {
    const tag = submissionTag(randomUUID());
    expect(tag).toMatch(/^cod-[A-Za-z0-9]+$/);
  });

  it("puts the tag on the draft, and the EXACT key in a custom attribute", () => {
    // The tag is compacted and truncatable; the attribute is not. Recovery
    // searches by tag and can still verify the exact key afterwards.
    const key = randomUUID();
    const input = buildDraftOrderInput(source({ submissionKey: key }));
    expect(input.tags).toContain(submissionTag(key));
    expect(input.customAttributes).toContainEqual({ key: "submissionKey", value: key });
  });

  it("keeps every tag it sends within the limit", () => {
    const input = buildDraftOrderInput(source({ submissionKey: randomUUID() }));
    for (const tag of input.tags) {
      expect(tag.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    }
  });
});
