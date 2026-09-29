import { afterEach, describe, expect, it } from "vitest";

import { __resetShopifyEnv, hasShopifyEnv, shopifyEnv } from "@/src/lib/env";

const KEYS = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_ADMIN_ACCESS_TOKEN",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  __resetShopifyEnv();
});

function setShopify(values: Partial<Record<(typeof KEYS)[number], string>>) {
  __resetShopifyEnv();
  for (const key of KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

describe("shopify env is validated on use, not on import", () => {
  it("accepts a well-formed configuration", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "Example-Store.myshopify.com",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "placeholder-token-value",
      SHOPIFY_API_VERSION: "2026-07",
    });
    const env = shopifyEnv();
    // Lowercased: Shopify domains are case-insensitive, our comparisons are not.
    expect(env.shopDomain).toBe("example-store.myshopify.com");
    expect(env.apiVersion).toBe("2026-07");
  });

  it("reports every problem at once rather than one per restart", () => {
    setShopify({});
    try {
      shopifyEnv();
      throw new Error("expected shopifyEnv() to throw");
    } catch (error) {
      const message = (error as Error).message;
      for (const key of KEYS) expect(message).toContain(key);
    }
  });

  it("accepts client credentials with no permanent token -- the primary path", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "store.myshopify.com",
      SHOPIFY_API_VERSION: "2026-07",
      SHOPIFY_CLIENT_ID: "placeholder-client-id",
      SHOPIFY_CLIENT_SECRET: "placeholder-client-secret",
    });
    const env = shopifyEnv();
    expect(env.clientId).toBe("placeholder-client-id");
    expect(env.accessToken).toBe("");
  });

  it("rejects a client id with no secret", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "store.myshopify.com",
      SHOPIFY_API_VERSION: "2026-07",
      SHOPIFY_CLIENT_ID: "placeholder-client-id",
    });
    expect(() => shopifyEnv()).toThrow(/SHOPIFY_CLIENT_SECRET is required/);
  });

  it("rejects a configuration with neither mechanism", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "store.myshopify.com",
      SHOPIFY_API_VERSION: "2026-07",
    });
    expect(() => shopifyEnv()).toThrow(/SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET/);
  });

  it("never puts the client secret in an error message", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "bad-domain",
      SHOPIFY_API_VERSION: "2026-07",
      SHOPIFY_CLIENT_ID: "placeholder-client-id",
      SHOPIFY_CLIENT_SECRET: "super-secret-client-secret",
    });
    try {
      shopifyEnv();
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-client-secret");
    }
  });

  it("rejects an unpinned API version", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "store.myshopify.com",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "placeholder",
      SHOPIFY_API_VERSION: "latest",
    });
    expect(() => shopifyEnv()).toThrow(/pinned version/);
  });

  it("rejects a domain that is not a myshopify host", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "https://store.example.com",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "placeholder",
      SHOPIFY_API_VERSION: "2026-07",
    });
    expect(() => shopifyEnv()).toThrow(/myshopify\.com/);
  });

  it("lets the web process run without a Shopify credential at all", () => {
    // The storefront reads MySQL and never calls Shopify. Requiring a token to
    // boot Next would enforce the opposite of that boundary.
    setShopify({});
    expect(hasShopifyEnv()).toBe(false);
  });

  it("never puts the token in the error message", () => {
    setShopify({
      SHOPIFY_SHOP_DOMAIN: "bad-domain",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_supersecretvalue",
      SHOPIFY_API_VERSION: "2026-07",
    });
    try {
      shopifyEnv();
    } catch (error) {
      expect((error as Error).message).not.toContain("shpat_supersecretvalue");
    }
  });
});
