/**
 * Choosing the payment terms that mean "cash on delivery".
 *
 * `draftOrderComplete(paymentPending:)` is deprecated on the pinned API version
 * in favour of payment terms on the draft, so this choice is now what makes the
 * resulting Shopify order UNPAID. Picking a NET template instead would tell the
 * merchant the money is due in 30 days -- a different commercial arrangement,
 * silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.fn();

// Replaces the module, so no Shopify credential is needed and no request is made.
vi.mock("@/src/lib/shopify/client", () => ({
  shopifyGraphQL: (...args: unknown[]) => graphql(...args),
}));

const { __resetPaymentTermsCache, resolveCodPaymentTerms, COD_TEMPLATE_PREFERENCE } = await import(
  "@/src/lib/orders/payment-terms"
);

function templates(...rows: Array<{ id: string; name: string; paymentTermsType: string; dueInDays?: number | null }>) {
  return {
    data: {
      paymentTermsTemplates: rows.map((row) => ({ dueInDays: null, ...row })),
    },
    cost: null,
  };
}

/** The set the development store actually returns, in its actual order. */
function realisticShopTemplates() {
  return templates(
    { id: "gid://shopify/PaymentTermsTemplate/1", name: "Due on receipt", paymentTermsType: "RECEIPT" },
    { id: "gid://shopify/PaymentTermsTemplate/9", name: "Due on fulfillment", paymentTermsType: "FULFILLMENT" },
    { id: "gid://shopify/PaymentTermsTemplate/2", name: "Net 7", paymentTermsType: "NET", dueInDays: 7 },
    { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
    { id: "gid://shopify/PaymentTermsTemplate/7", name: "Fixed", paymentTermsType: "FIXED" },
  );
}

beforeEach(() => {
  graphql.mockReset();
  __resetPaymentTermsCache();
});

describe("resolveCodPaymentTerms: preference", () => {
  it("prefers 'due on fulfillment', which is what COD means", () => {
    // Note RECEIPT comes FIRST in the shop's response. Preference must come from
    // our order, not the API's.
    graphql.mockResolvedValue(realisticShopTemplates());

    return resolveCodPaymentTerms().then((terms) => {
      expect(terms?.templateType).toBe("FULFILLMENT");
      expect(terms?.templateId).toBe("gid://shopify/PaymentTermsTemplate/9");
    });
  });

  it("falls back to 'due on receipt' when fulfillment terms are absent", async () => {
    graphql.mockResolvedValue(
      templates(
        { id: "gid://x/1", name: "Due on receipt", paymentTermsType: "RECEIPT" },
        { id: "gid://x/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
      ),
    );

    const terms = await resolveCodPaymentTerms();
    expect(terms?.templateType).toBe("RECEIPT");
  });

  it("never selects NET or FIXED terms", async () => {
    // Either would put a due date weeks away on a parcel being paid for at the
    // door.
    graphql.mockResolvedValue(
      templates(
        { id: "gid://x/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
        { id: "gid://x/7", name: "Fixed", paymentTermsType: "FIXED" },
      ),
    );

    expect(await resolveCodPaymentTerms()).toBeNull();
  });

  it("states its preference order explicitly", () => {
    expect([...COD_TEMPLATE_PREFERENCE]).toEqual(["FULFILLMENT", "RECEIPT"]);
  });
});

describe("resolveCodPaymentTerms: degraded shops", () => {
  it("returns null rather than throwing when the shop has no usable template", async () => {
    // A draft with no payment terms is still a correct unpaid draft. Refusing to
    // submit a customer's order over a missing shop setting would be a far worse
    // outcome than a missing due date.
    graphql.mockResolvedValue(templates());
    expect(await resolveCodPaymentTerms()).toBeNull();
  });

  it("tolerates a null templates array", async () => {
    graphql.mockResolvedValue({ data: { paymentTermsTemplates: null }, cost: null });
    expect(await resolveCodPaymentTerms()).toBeNull();
  });
});

describe("resolveCodPaymentTerms: caching", () => {
  it("queries once and reuses the answer", async () => {
    graphql.mockResolvedValue(realisticShopTemplates());

    await resolveCodPaymentTerms();
    await resolveCodPaymentTerms();
    await resolveCodPaymentTerms();

    // Templates are shop configuration. Re-asking per order spends Shopify's cost
    // budget to learn the same thing.
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("caches the negative answer too", async () => {
    // Otherwise a shop with no usable template is re-queried on every single
    // order, forever.
    graphql.mockResolvedValue(templates());

    await resolveCodPaymentTerms();
    await resolveCodPaymentTerms();

    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("re-queries after the cache is reset", async () => {
    graphql.mockResolvedValue(realisticShopTemplates());
    await resolveCodPaymentTerms();
    __resetPaymentTermsCache();
    await resolveCodPaymentTerms();
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure, so a transient error is retried", async () => {
    graphql.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(resolveCodPaymentTerms()).rejects.toThrow("socket hang up");

    graphql.mockResolvedValue(realisticShopTemplates());
    const terms = await resolveCodPaymentTerms();
    expect(terms?.templateType).toBe("FULFILLMENT");
  });
});
