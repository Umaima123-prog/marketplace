/**
 * How a product's variants are presented as selectable options.
 *
 * Pure, and deliberately derived from the data the storefront actually has.
 * Shopify's option NAMES ("Color", "Switch Type", "Case Size") are parsed by the
 * sync mapper but never persisted -- there is no option table and the product
 * row has no options column -- so the only option data in MySQL is each
 * variant's `title`. Everything here reads those titles; nothing is keyed to a
 * product handle or a variant id, so a new product picks up the right treatment
 * with no code change.
 *
 * Separated from the component so the classification can be tested directly
 * rather than through a DOM.
 */

/**
 * Colour words to a swatch colour.
 *
 * Longest-first: "Space Grey" must win over the bare "Grey" that follows it, or
 * the two variants of a silver/space-grey product would show the same dot.
 * Matched on word boundaries so "Blue Switch" resolves while a hypothetical
 * "Bluetooth" does not.
 */
const COLOR_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bspace\s*gr[ea]y\b/i, "#4a4f57"],
  [/\bmidnight\b/i, "#161b22"],
  [/\bgraphite\b/i, "#3a3f45"],
  [/\bcharcoal\b/i, "#36393d"],
  [/\bblack\b/i, "#1b1f24"],
  [/\bwhite\b/i, "#f7f8fa"],
  [/\bsilver\b/i, "#c9ced4"],
  [/\bgr[ea]y\b/i, "#8b9099"],
  [/\bnavy\b/i, "#1e3a8a"],
  [/\bblue\b/i, "#2563eb"],
  [/\bred\b/i, "#dc2626"],
  [/\bgreen\b/i, "#16a34a"],
  [/\byellow\b/i, "#eab308"],
  [/\borange\b/i, "#ea580c"],
  [/\bpurple\b/i, "#7c3aed"],
  [/\bpink\b/i, "#ec4899"],
  [/\bgold\b/i, "#c9a227"],
  [/\bbronze\b/i, "#a97142"],
  [/\bbeige\b/i, "#e8dcc8"],
  [/\bbrown\b/i, "#7c4a21"],
];

/** Swatches this light need a ring, or they vanish against a white card. */
const LIGHT_SWATCHES = new Set(["#f7f8fa", "#c9ced4", "#e8dcc8"]);

export interface OptionSwatch {
  /** CSS colour for the dot. */
  color: string;
  /** True when the dot needs a visible outline to be seen on white. */
  needsOutline: boolean;
}

/**
 * The swatch colour implied by a variant title, or null when it implies none.
 *
 * "Black" and "Blue Switch" both resolve; "42mm" and "8-in-1" do not, and get a
 * plain chip instead of a pretend colour.
 */
export function swatchFor(title: string): OptionSwatch | null {
  for (const [pattern, color] of COLOR_TOKENS) {
    if (pattern.test(title)) {
      return { color, needsOutline: LIGHT_SWATCHES.has(color) };
    }
  }
  return null;
}

/**
 * True when the title is nothing BUT a colour name.
 *
 * "Black" yes; "Blue Switch" no -- it is a switch type that happens to be
 * named after a colour. The distinction decides the group heading: calling a
 * keyboard's switch types "Available Colors" would be wrong.
 */
export function isPureColorName(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  for (const [pattern] of COLOR_TOKENS) {
    const match = pattern.exec(trimmed);
    if (match && match[0].length === trimmed.length) return true;
  }
  return false;
}

/**
 * Heading for the option group.
 *
 * Only claims "Colors" when every value really is just a colour. Anything else
 * -- sizes, capacities, switch types, a mix -- gets the neutral heading, because
 * the option's real name is not available to this layer (see the file header).
 */
export function optionGroupLabel(titles: readonly string[]): string {
  if (titles.length > 0 && titles.every(isPureColorName)) return "Available Colors";
  return "Available Options";
}

/**
 * Chips, or a `<select>`?
 *
 * Chips are the better control for the handful of options a real product has,
 * and this catalog has at most two. A product with dozens of variants would
 * wrap into an unusable wall of buttons, so past a threshold the original
 * dropdown stays -- the same data, a control that still works.
 */
export const MAX_CHIP_OPTIONS = 12;

export function shouldUseChips(variantCount: number): boolean {
  return variantCount > 1 && variantCount <= MAX_CHIP_OPTIONS;
}

/**
 * A short plain-text lead-in taken from the product's description HTML.
 *
 * Plain TEXT on purpose: the full description is rendered as markup further
 * down the page, but this excerpt sits in a heading block where stray markup
 * would break the layout, so tags are stripped and the result is rendered as a
 * string. Nothing user-supplied reaches it either way -- the description comes
 * from the merchant's own Shopify admin through the sync worker.
 */
export function excerptFromHtml(html: string | null, maxChars = 180): string | null {
  if (!html) return null;

  const text = html
    // Treat block boundaries as spaces so "</p><p>" does not glue words.
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length === 0) return null;
  if (text.length <= maxChars) return text;

  // Cut on a word boundary rather than mid-word, then add the ellipsis.
  const clipped = text.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
