/**
 * Phone number validation and normalisation to E.164.
 *
 * This exists because of a verified failure, not a hypothetical one. The checkout
 * used to require only a non-empty phone string, on the reasoning that "phone
 * formats vary by country and the courier is the real validator". The courier is
 * not the first validator: **Shopify is**. `draftOrderCreate` answers
 * `phone: Phone is invalid` for a number it does not recognise, and by then the
 * local order is committed, the shopper has seen a confirmation page, and the
 * order can only move to `FAILED` in the background where nobody sees it. Two
 * real orders were lost that way (VERIFICATION.md §5a).
 *
 * So the rule moved forward, to before the order exists.
 *
 * What is deliberately NOT here: a numbering-plan database. Deciding that
 * `+923009999999` is unassigned needs per-country subscriber-number rules for 249
 * countries, kept current. That is a dependency and a maintenance obligation, and
 * getting it subtly wrong rejects real customers — the failure mode this module
 * exists to avoid. The line drawn instead is **structural validity**: an E.164
 * number is a `+`, a country code that cannot start with zero, and 7 to 15 digits
 * in total. Everything structurally impossible is refused here; everything
 * structurally valid is Shopify's call, and a rejection then is a genuine
 * disagreement rather than a format we could have caught.
 *
 * Pure, dependency-free and not `server-only` on purpose: the server decides, and
 * the checkout form reuses the identical function to spare a round trip.
 */

/**
 * E.164 allows at most 15 digits including the country code. The minimum is not
 * defined by the standard, but 7 is the shortest real international number in
 * use (small territories such as `+290` and `+683` have four-digit subscriber
 * numbers), so a higher floor would reject genuine customers.
 */
export const MIN_PHONE_DIGITS = 7;
export const MAX_PHONE_DIGITS = 15;

/** What a valid number looks like, used in every message so the fix is obvious. */
const EXAMPLE = "+923001234567";

export type PhoneResult =
  | { ok: true; e164: string }
  | { ok: false; message: string };

/**
 * Separators people actually type, and nothing else. Letters, `#`, `*` and `/`
 * are **not** stripped: silently discarding them would turn a typo into a
 * different, possibly real, phone number.
 *
 * The dash class covers the Unicode dashes that phones and keyboards produce
 * (hyphen-minus, non-breaking hyphen, en/em dash) plus the non-breaking space a
 * paste from a web page often carries.
 *
 * The plain hyphen is written LAST, where it can only be a literal. Written in
 * the middle it silently becomes a range operator: `[.-‐-―]`
 * parses as `.` through `‐`, which swallows every digit — so the class
 * stripped the number itself and left a bare `+`. Caught by running this against
 * the two phone numbers Shopify had already accepted.
 */
const SEPARATORS = /[\s ().‐-―-]/g;

/**
 * Validates a phone number and returns it in E.164 form.
 *
 * Accepts the two international spellings in real use — a leading `+`, and the
 * ITU access prefix `00`, which means the same thing — with human separators
 * anywhere. It does not accept a national number: `03001234567` is a valid
 * Pakistani number locally and meaningless to a courier API, and the country
 * code cannot be inferred from the delivery country without a 249-entry dialling
 * table whose wrong guesses would be silent. The message says what to add.
 */
export function normalizePhone(raw: string): PhoneResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Phone number is required" };
  }

  const compact = trimmed.replace(SEPARATORS, "");

  // `00` is the international access prefix and is exactly equivalent to `+`.
  const international = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;

  if (!international.startsWith("+")) {
    return {
      ok: false,
      message: `Include your country code, for example ${EXAMPLE}`,
    };
  }

  const digits = international.slice(1);
  if (digits.length === 0 || !/^[0-9]+$/.test(digits)) {
    return {
      ok: false,
      message: `Enter a valid phone number, for example ${EXAMPLE}`,
    };
  }

  // A country code never begins with 0, so "+0…" is a national number that has
  // had a "+" put in front of it rather than a country code added.
  if (digits.startsWith("0")) {
    return {
      ok: false,
      message: `A country code cannot start with 0, for example ${EXAMPLE}`,
    };
  }

  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return {
      ok: false,
      message: `Phone number must be ${MIN_PHONE_DIGITS}–${MAX_PHONE_DIGITS} digits including the country code, for example ${EXAMPLE}`,
    };
  }

  return { ok: true, e164: `+${digits}` };
}

/** True when `raw` is a structurally valid international number. */
export function isValidPhone(raw: string): boolean {
  return normalizePhone(raw).ok;
}
