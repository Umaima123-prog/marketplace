/**
 * Variant-specific images: the two pure decisions behind the feature.
 *
 * 1. `mapVariantImageId` — reading Shopify's answer out of the variant's media
 *    connection, including every shape that means "no image".
 * 2. `resolveVariantImage` — turning that answer plus the product's image index
 *    into the `imageId` column, where the interesting part is the difference
 *    between *authoritatively none* and *not asked*. Getting that wrong is how a
 *    partial payload would wipe a correct mapping.
 *
 * `ProductVariant.image` is deprecated on API 2026-07 ("Use `media` instead"),
 * so the shapes below are media-connection shapes.
 */
import { describe, expect, it } from "vitest";

import { mapVariant, mapVariantImageId } from "@/src/lib/sync/product-mapper";
import { resolveVariantImage } from "@/src/lib/sync/catalog-repo";

import { variantNode } from "./fixtures";

const MEDIA = "gid://shopify/MediaImage/900";

/** A media connection holding one assigned image. */
const oneImage = (id = MEDIA) => ({ nodes: [{ id }] });

describe("mapVariantImageId", () => {
  it("returns the assigned MediaImage id", () => {
    expect(mapVariantImageId(oneImage(), "v.media")).toBe(MEDIA);
  });

  it("returns the FIRST id when several are present", () => {
    // The query asks for one, but a payload is not a promise.
    expect(
      mapVariantImageId({ nodes: [{ id: "gid://shopify/MediaImage/1" }, { id: "gid://shopify/MediaImage/2" }] }, "v.media"),
    ).toBe("gid://shopify/MediaImage/1");
  });

  it("returns null for every shape that means no assigned image", () => {
    for (const [label, media] of [
      ["absent", undefined],
      ["null", null],
      ["empty nodes", { nodes: [] }],
      // A video assigned to a variant: the inline MediaImage fragment matches
      // nothing, so the node arrives with no id. Must read as "no image".
      ["a non-MediaImage node", { nodes: [{}] }],
      ["a node with a null id", { nodes: [{ id: null }] }],
      ["a node with an empty id", { nodes: [{ id: "" }] }],
    ] as const) {
      expect(mapVariantImageId(media, "v.media"), label).toBeNull();
    }
  });

  it("skips a leading non-image node and finds the image behind it", () => {
    expect(mapVariantImageId({ nodes: [{}, { id: MEDIA }] }, "v.media")).toBe(MEDIA);
  });

  it("is reached by mapVariant, so a mapped variant carries the id", () => {
    expect(mapVariant(variantNode({ media: oneImage() }), "v", 0).shopifyImageId).toBe(MEDIA);
    // The shared fixture has no media at all, which is the common case.
    expect(mapVariant(variantNode(), "v", 0).shopifyImageId).toBeNull();
  });
});

describe("resolveVariantImage", () => {
  const index = new Map([[MEDIA, "local-image-id"]]);

  it("maps an assigned image to the local ProductImage id", () => {
    expect(resolveVariantImage(MEDIA, index)).toEqual({ imageId: "local-image-id" });
  });

  it("clears the mapping when Shopify reports no assigned image", () => {
    // Authoritative "none": Shopify was asked. A variant that previously had an
    // image must lose it, or the storefront would keep showing a stale one.
    expect(resolveVariantImage(null, index)).toEqual({ imageId: null });
  });

  it("writes NOTHING when no index was supplied", () => {
    // Not asked. The caller has not reconciled this product's images, so it
    // cannot assert either an image or its absence -- and an `imageId: null`
    // here would wipe a correct mapping. An empty object leaves the column
    // untouched, which is what protects a partial payload.
    expect(resolveVariantImage(MEDIA, undefined)).toEqual({});
    expect(resolveVariantImage(null, undefined)).toEqual({});
  });

  it("resolves to null when the assigned image is not among the product's images", () => {
    // A Shopify state we do not control; the fallback renders correctly, and a
    // throw here would fail the whole sync over one odd variant.
    expect(resolveVariantImage("gid://shopify/MediaImage/does-not-exist", index)).toEqual({
      imageId: null,
    });
  });

  it("never invents an id", () => {
    const result = resolveVariantImage(MEDIA, new Map());
    expect(result.imageId).toBeNull();
  });
});
