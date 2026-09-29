/**
 * How "unpaid, collect cash on delivery" is expressed to Shopify.
 *
 * Two mechanisms exist on API 2026-07 and neither is unconditionally available,
 * which is why this is configuration rather than a constant:
 *
 *   payment_pending (default) - `draftOrderComplete(paymentPending: true)`.
 *       Deprecated, but present, functional, and needs no extra permission. This
 *       is what produced the verified live order: financial status PENDING, full
 *       amount outstanding.
 *
 *   payment_terms             - payment terms on the draft; the non-deprecated
 *       path. `draftOrderCreate` refuses it for this app: "The user must have
 *       access to set payment terms."
 *
 * The live run is the reason these tests exist. `draftOrderCalculate` ACCEPTS the
 * payment-terms input, so validating the input shape proved nothing — only the
 * real mutation revealed the permission. The mode must therefore be switchable,
 * and getting it wrong must be diagnosable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.fn();

vi.mock("@/src/lib/shopify/client", () => ({
  shopifyGraphQL: (...args: unknown[]) => graphql(...args),
}));

/** A successful draftOrderComplete payload. */
function completeOk() {
  return {
    data: {
      draftOrderComplete: {
        draftOrder: {
          id: "gid://shopify/DraftOrder/1",
          name: "#D1",
          status: "COMPLETED",
          order: { id: "gid://shopify/Order/1", name: "#1001" },
        },
        userErrors: [],
      },
    },
    cost: null,
  };
}

function createOk() {
  return {
    data: {
      draftOrderCreate: {
        draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", status: "OPEN", order: null },
        userErrors: [],
      },
    },
    cost: null,
  };
}

function createRefused(message: string) {
  return {
    data: {
      draftOrderCreate: { draftOrder: null, userErrors: [{ field: null, message }] },
    },
    cost: null,
  };
}

function templates() {
  return {
    data: {
      paymentTermsTemplates: [
        { id: "gid://shopify/PaymentTermsTemplate/9", name: "Due on fulfillment", paymentTermsType: "FULFILLMENT", dueInDays: null },
      ],
    },
    cost: null,
  };
}

/**
 * `env` is validated and frozen at import, so the mode can only be changed by
 * re-importing the module graph.
 */
async function loadPort(mode: string | undefined) {
  vi.resetModules();
  if (mode === undefined) vi.stubEnv("SHOPIFY_COD_PAYMENT_MODE", "");
  else vi.stubEnv("SHOPIFY_COD_PAYMENT_MODE", mode);

  const [{ createShopifyPort }, { __resetPaymentTermsCache }, submit] = await Promise.all([
    import("@/src/lib/orders/shopify-port"),
    import("@/src/lib/orders/payment-terms"),
    import("@/src/lib/orders/submit-order"),
  ]);
  __resetPaymentTermsCache();
  return { port: createShopifyPort(), PermanentSubmissionError: submit.PermanentSubmissionError };
}

/** The variables of the Nth graphql call. */
function variablesOf(call: number): Record<string, unknown> {
  return (graphql.mock.calls[call]?.[1] as { variables?: Record<string, unknown> })?.variables ?? {};
}

beforeEach(() => graphql.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("payment_pending mode (the default)", () => {
  it("is the default when the variable is unset", async () => {
    const { port } = await loadPort(undefined);
    graphql.mockResolvedValue(completeOk());

    await port.completeDraftOrder("gid://shopify/DraftOrder/1");

    expect(variablesOf(0).paymentPending).toBe(true);
  });

  it("is the default for an unrecognised value, rather than failing to boot", async () => {
    const { port } = await loadPort("nonsense");
    graphql.mockResolvedValue(completeOk());

    await port.completeDraftOrder("gid://shopify/DraftOrder/1");

    expect(variablesOf(0).paymentPending).toBe(true);
  });

  it("sends paymentPending: true on completion", async () => {
    // This is what makes the resulting Shopify order unpaid. Verified live:
    // displayFinancialStatus PENDING, full amount outstanding.
    const { port } = await loadPort("payment_pending");
    graphql.mockResolvedValue(completeOk());

    await port.completeDraftOrder("gid://shopify/DraftOrder/1");

    expect(variablesOf(0)).toEqual({ id: "gid://shopify/DraftOrder/1", paymentPending: true });
  });

  it("keeps payment terms OFF the draft, without spending a call to look one up", async () => {
    // Setting terms needs a permission this app lacks, and `draftOrderCreate`
    // refuses the WHOLE mutation when they are present -- so the template must not
    // even be resolved.
    const { port } = await loadPort("payment_pending");

    expect(await port.resolvePaymentTermsTemplateId()).toBeUndefined();
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe("payment_terms mode", () => {
  it("resolves the shop's COD template", async () => {
    const { port } = await loadPort("payment_terms");
    graphql.mockResolvedValue(templates());

    expect(await port.resolvePaymentTermsTemplateId()).toBe("gid://shopify/PaymentTermsTemplate/9");
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("does NOT send paymentPending, because the draft carries the terms instead", async () => {
    // Two mechanisms for one fact would be a conflict, not belt and braces.
    const { port } = await loadPort("payment_terms");
    graphql.mockResolvedValue(completeOk());

    await port.completeDraftOrder("gid://shopify/DraftOrder/1");

    expect(variablesOf(0).paymentPending).toBeNull();
  });
});

describe("the payment-terms permission refusal", () => {
  it("is classified with its own reason, naming the way out", async () => {
    // The exact message from the live run. A generic `draft_create_user_error`
    // would leave an operator reading Shopify's wording and guessing.
    const { port, PermanentSubmissionError } = await loadPort("payment_terms");
    graphql.mockResolvedValue(createRefused("The user must have access to set payment terms."));

    await expect(port.createDraftOrder({} as never)).rejects.toThrow(PermanentSubmissionError);

    try {
      await port.createDraftOrder({} as never);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe("payment_terms_forbidden");
      expect((error as Error).message).toContain("SHOPIFY_COD_PAYMENT_MODE=payment_pending");
      // Shopify's own wording is preserved, so the log says what was refused.
      expect((error as Error).message).toContain("access to set payment terms");
    }
  });

  it("matches the message wherever it appears in a multi-error response", async () => {
    const { port } = await loadPort("payment_terms");
    graphql.mockResolvedValue({
      data: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [
            { field: ["tags", "1"], message: "Something else" },
            { field: null, message: "The user must have access to set payment terms." },
          ],
        },
      },
      cost: null,
    });

    try {
      await port.createDraftOrder({} as never);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe("payment_terms_forbidden");
    }
  });

  it("leaves every other userError on the generic reason", async () => {
    const { port } = await loadPort("payment_pending");
    graphql.mockResolvedValue(createRefused("Variant does not exist"));

    try {
      await port.createDraftOrder({} as never);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe("draft_create_user_error");
      expect((error as Error).message).toContain("Variant does not exist");
    }
  });

  it("treats a clean create as a success", async () => {
    const { port } = await loadPort("payment_pending");
    graphql.mockResolvedValue(createOk());

    const draft = await port.createDraftOrder({} as never);
    expect(draft.id).toBe("gid://shopify/DraftOrder/1");
  });
});

describe("the completion mutation's shape", () => {
  it("passes the flag as a variable, never interpolated into the document", async () => {
    // A literal in the document would make the mode uncontrollable at runtime.
    const { port } = await loadPort("payment_pending");
    graphql.mockResolvedValue(completeOk());

    await port.completeDraftOrder("gid://shopify/DraftOrder/1");

    const document = graphql.mock.calls[0]?.[0] as string;
    expect(document).toContain("$paymentPending: Boolean");
    expect(document).toContain("paymentPending: $paymentPending");
    expect(document).not.toContain("paymentPending: true");
  });

  it("never sends a payment gateway, because nothing was charged", async () => {
    const { port } = await loadPort("payment_pending");
    graphql.mockResolvedValue(completeOk());

    await port.completeDraftOrder("gid://shopify/DraftOrder/1");

    expect(graphql.mock.calls[0]?.[0]).not.toContain("paymentGatewayId");
    expect(variablesOf(0)).not.toHaveProperty("paymentGatewayId");
  });
});
