/**
 * How variants become selectable options on the product page.
 *
 * This logic exists because Shopify's option NAMES are not available to the
 * storefront: the sync mapper parses them but nothing persists them, so the
 * only option data in MySQL is each variant's title. Everything here is derived
 * from those titles, which is why it is worth pinning -- a wrong guess shows a
 * shopper a red dot next to a capacity, or calls a keyboard's switch types
 * "Available Colors".
 *
 * Nothing is keyed to a product handle or a variant id, so these cases are
 * written as the shapes the catalog actually contains rather than as products.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_CHIP_OPTIONS,
  excerptFromHtml,
  isPureColorName,
  optionGroupLabel,
  shouldUseChips,
  swatchFor,
} from "@/src/lib/storefront/option-display";

describe("swatchFor", () => {
  it("resolves a colour for the colour options in the catalog", () => {
    for (const title of ["Black", "White", "Blue", "Silver", "Space Grey"]) {
      expect(swatchFor(title), title).not.toBeNull();
    }
  });

  it("prefers the longest match, so Space Grey is not plain Grey", () => {
    const spaceGrey = swatchFor("Space Grey");
    const grey = swatchFor("Grey");
    expect(spaceGrey).not.toBeNull();
    expect(grey).not.toBeNull();
    expect(spaceGrey?.color).not.toBe(grey?.color);
  });

  it("accepts both spellings of grey", () => {
    expect(swatchFor("Space Gray")?.color).toBe(swatchFor("Space Grey")?.color);
    expect(swatchFor("Gray")?.color).toBe(swatchFor("Grey")?.color);
  });

  it("resolves a colour inside a longer option name", () => {
    // Switch types are named after colours, and a red/blue dot is genuinely
    // informative for a mechanical keyboard.
    expect(swatchFor("Red Switch")?.color).toBe(swatchFor("Red")?.color);
    expect(swatchFor("Blue Switch")?.color).toBe(swatchFor("Blue")?.color);
  });

  it("returns null for options that are not colours at all", () => {
    // A dot here would invent meaning that is not in the data.
    for (const title of ["42mm", "46mm", "6-in-1", "8-in-1", "10,000mAh", "20,000mAh", "Default Title"]) {
      expect(swatchFor(title), title).toBeNull();
    }
  });

  it("matches whole words only, so a colour buried in another word is ignored", () => {
    // Each of these CONTAINS a colour name as a substring and is not a colour.
    // Word-boundary matching is what keeps a Bluetooth speaker option from
    // getting a blue dot and a redwood finish from getting a red one.
    for (const title of ["Bluetooth", "Redwood Finish", "Whitewater", "Blackcurrant Edition"]) {
      expect(swatchFor(title), title).toBeNull();
    }
    // The same word, separated, does resolve.
    expect(swatchFor("Red Switch")).not.toBeNull();
  });

  it("flags pale swatches as needing an outline", () => {
    // White on a white chip is invisible without a ring.
    expect(swatchFor("White")?.needsOutline).toBe(true);
    expect(swatchFor("Silver")?.needsOutline).toBe(true);
    expect(swatchFor("Black")?.needsOutline).toBe(false);
    expect(swatchFor("Blue")?.needsOutline).toBe(false);
  });
});

describe("isPureColorName", () => {
  it("is true when the title is only a colour", () => {
    for (const title of ["Black", "White", "Blue", "Silver", "Space Grey", "  Black  "]) {
      expect(isPureColorName(title), title).toBe(true);
    }
  });

  it("is false when the colour is qualifying something else", () => {
    for (const title of ["Red Switch", "Blue Switch", "Midnight Edition", "42mm", ""]) {
      expect(isPureColorName(title), title).toBe(false);
    }
  });
});

describe("optionGroupLabel", () => {
  it('says "Available Colors" only when every option is a colour', () => {
    expect(optionGroupLabel(["Black", "White"])).toBe("Available Colors");
    expect(optionGroupLabel(["Black", "Blue"])).toBe("Available Colors");
    expect(optionGroupLabel(["Silver", "Space Grey"])).toBe("Available Colors");
  });

  it("falls back to a neutral label for anything else", () => {
    // Switch types are not colours, sizes are not colours, and the real option
    // name is not available to this layer -- so it does not pretend to know it.
    expect(optionGroupLabel(["Red Switch", "Blue Switch"])).toBe("Available Options");
    expect(optionGroupLabel(["42mm", "46mm"])).toBe("Available Options");
    expect(optionGroupLabel(["6-in-1", "8-in-1"])).toBe("Available Options");
    expect(optionGroupLabel(["10,000mAh", "20,000mAh"])).toBe("Available Options");
    // A mix must not be called colours on the strength of one value.
    expect(optionGroupLabel(["Black", "42mm"])).toBe("Available Options");
    expect(optionGroupLabel([])).toBe("Available Options");
  });
});

describe("shouldUseChips", () => {
  it("uses chips for the handful of options a real product has", () => {
    expect(shouldUseChips(2)).toBe(true);
    expect(shouldUseChips(MAX_CHIP_OPTIONS)).toBe(true);
  });

  it("renders no option control for a single-variant product", () => {
    expect(shouldUseChips(1)).toBe(false);
    expect(shouldUseChips(0)).toBe(false);
  });

  it("keeps the dropdown past the threshold", () => {
    // Dozens of chips would be a wall of buttons; the select still works.
    expect(shouldUseChips(MAX_CHIP_OPTIONS + 1)).toBe(false);
    expect(shouldUseChips(120)).toBe(false);
  });
});

describe("excerptFromHtml", () => {
  it("returns plain text, with the markup stripped", () => {
    expect(excerptFromHtml("<p>Over-ear <strong>wireless</strong> headphones.</p>")).toBe(
      "Over-ear wireless headphones.",
    );
  });

  it("does not glue words together across block boundaries", () => {
    expect(excerptFromHtml("<p>First line.</p><p>Second line.</p>")).toBe(
      "First line. Second line.",
    );
    expect(excerptFromHtml("<li>One</li><li>Two</li>")).toBe("One Two");
  });

  it("decodes the entities a description actually contains", () => {
    expect(excerptFromHtml("<p>Fast &amp; quiet&nbsp;typing</p>")).toBe("Fast & quiet typing");
    expect(excerptFromHtml("<p>It&#39;s light</p>")).toBe("It's light");
  });

  it("truncates on a word boundary and marks the cut", () => {
    const long = `<p>${"word ".repeat(80)}</p>`;
    const excerpt = excerptFromHtml(long, 40);
    expect(excerpt).not.toBeNull();
    expect(excerpt!.length).toBeLessThanOrEqual(41); // 40 plus the ellipsis
    expect(excerpt!.endsWith("…")).toBe(true);
    expect(excerpt).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  it("leaves a short description untouched", () => {
    const excerpt = excerptFromHtml("<p>Short.</p>", 40);
    expect(excerpt).toBe("Short.");
    expect(excerpt!.endsWith("…")).toBe(false);
  });

  it("returns null when there is nothing to show", () => {
    // A product with no description, or markup that holds no text, renders no
    // lead paragraph at all rather than an empty one.
    expect(excerptFromHtml(null)).toBeNull();
    expect(excerptFromHtml("")).toBeNull();
    expect(excerptFromHtml("<p></p>")).toBeNull();
    expect(excerptFromHtml("   ")).toBeNull();
  });
});
