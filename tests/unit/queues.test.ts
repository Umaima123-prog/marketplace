import { describe, expect, it } from "vitest";

import { buildJobId, shortDigest } from "@/src/lib/queues";

describe("buildJobId", () => {
  it("never emits a colon -- BullMQ rejects a custom id containing one", () => {
    // This is not hypothetical: `${runId}:page:0` was rejected at runtime with
    // "Custom Id cannot contain :" on the first real sync.
    const id = buildJobId("run123", "page", 0);
    expect(id).not.toContain(":");
    expect(id).toBe("run123--page--0");
  });

  it("survives a Shopify GID, which carries both colons and slashes", () => {
    const id = buildJobId("run123", "variants", "gid://shopify/Product/456", "start");
    expect(id).not.toContain(":");
    expect(id).not.toContain("/");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("reduces any other punctuation to a safe separator", () => {
    expect(buildJobId("a b", "c/d", "e:f")).toBe("a-b--c-d--e-f");
  });

  it("keeps null and undefined segments distinguishable", () => {
    expect(buildJobId("run", null)).toBe("run--none");
    expect(buildJobId("run", undefined)).toBe("run--none");
  });

  it("never produces an empty segment", () => {
    expect(buildJobId("run", "***")).toBe("run--none");
  });
});

describe("shortDigest", () => {
  it("distinguishes different cursors without carrying them", () => {
    const a = shortDigest("eyJsYXN0X2lkIjoxMjN9");
    const b = shortDigest("eyJsYXN0X2lkIjo0NTZ9");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable, so a retry builds the same job id", () => {
    expect(shortDigest("cursor")).toBe(shortDigest("cursor"));
  });

  it("names the absence of a cursor rather than hashing it", () => {
    expect(shortDigest(null)).toBe("start");
    expect(shortDigest(undefined)).toBe("start");
    expect(shortDigest("")).toBe("start");
  });
});
