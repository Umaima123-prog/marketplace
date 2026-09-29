/**
 * Money formatting that never touches binary floating point.
 *
 * Prices are `DECIMAL(18,4)` in MySQL and arrive from Prisma as Decimal
 * objects. The moment one becomes a JS `number` the value is approximate:
 * `0.1 + 0.2 !== 0.3`, and on a COD order the stored number is cash a courier
 * physically collects (ARCHITECTURE §8).
 *
 * So the rule here is absolute: amounts move as STRINGS, and the only
 * arithmetic performed is on decimal strings. `Intl.NumberFormat` is not used
 * for the amount -- it takes a `number`, which would defeat the entire point.
 */

/** A currency amount as it crosses any boundary: an exact decimal string. */
export type MoneyString = string;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function isMoneyString(value: unknown): value is MoneyString {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

/**
 * Compares two decimal strings exactly.
 *
 * Returns <0, 0 or >0 like a comparator. Digit-wise, so `"9.99"` vs `"10.00"`
 * is decided by magnitude rather than by lexical order -- and without either
 * value becoming a float.
 */
export function compareMoney(a: MoneyString, b: MoneyString): number {
  const negA = a.startsWith("-");
  const negB = b.startsWith("-");
  if (negA !== negB) return negA ? -1 : 1;

  const sign = negA ? -1 : 1;
  const [intA, fracA = ""] = (negA ? a.slice(1) : a).split(".");
  const [intB, fracB = ""] = (negB ? b.slice(1) : b).split(".");

  const cleanA = intA.replace(/^0+(?=\d)/, "");
  const cleanB = intB.replace(/^0+(?=\d)/, "");
  if (cleanA.length !== cleanB.length) return (cleanA.length < cleanB.length ? -1 : 1) * sign;
  if (cleanA !== cleanB) return (cleanA < cleanB ? -1 : 1) * sign;

  const width = Math.max(fracA.length, fracB.length);
  const padA = fracA.padEnd(width, "0");
  const padB = fracB.padEnd(width, "0");
  if (padA === padB) return 0;
  return (padA < padB ? -1 : 1) * sign;
}

/** The smaller of two decimal strings, exactly. */
export function minMoney(a: MoneyString, b: MoneyString): MoneyString {
  return compareMoney(a, b) <= 0 ? a : b;
}

/**
 * Gives a decimal string a consistent minimum scale WITHOUT losing digits.
 *
 * `Decimal.toString()` strips trailing zeros, so `15.0000` arrives as `"15"`
 * and sits next to `"9.99"` in the same response -- inconsistent on the wire
 * and ugly anywhere a consumer prints it raw.
 *
 * Padding is the fix, not rounding: the column is DECIMAL(18,4), and a price
 * that genuinely carries four decimals must keep all four. So `"15"` becomes
 * `"15.00"` while `"1234567890123.4567"` is returned untouched.
 */
export function normalizeMoney(amount: MoneyString, minPlaces = 2): MoneyString {
  if (!isMoneyString(amount)) throw new TypeError(`not a decimal amount: ${amount}`);
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length >= minPlaces) return amount;
  return `${whole}.${fraction.padEnd(minPlaces, "0")}`;
}

/**
 * Rounds a decimal string to `places`, half-up, by string surgery.
 *
 * Half-up because that is the convention the money rule in ARCHITECTURE §8
 * names, and because "round half to even" surprises people reading an invoice.
 */
export function roundMoney(amount: MoneyString, places = 2): MoneyString {
  if (!isMoneyString(amount)) throw new TypeError(`not a decimal amount: ${amount}`);

  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ""] = unsigned.split(".");

  if (fraction.length <= places) {
    return `${negative ? "-" : ""}${whole}.${fraction.padEnd(places, "0")}`;
  }

  const keep = fraction.slice(0, places);
  const nextDigit = Number(fraction[places]);

  let digits = `${whole}${keep}`;
  if (nextDigit >= 5) {
    // Increment the kept digits as an integer string, so a carry across "9.99"
    // -> "10.00" works without ever building a number.
    digits = incrementDigits(digits);
  }

  const padded = digits.padStart(places + 1, "0");
  const intPart = padded.slice(0, padded.length - places) || "0";
  const fracPart = places > 0 ? `.${padded.slice(padded.length - places)}` : "";
  const result = `${intPart}${fracPart}`;

  // "-0.00" is not a price.
  if (negative && /^0(\.0*)?$/.test(result)) return result;
  return `${negative ? "-" : ""}${result}`;
}

function incrementDigits(digits: string): string {
  const out = digits.split("");
  let i = out.length - 1;
  while (i >= 0) {
    if (out[i] === "9") {
      out[i] = "0";
      i -= 1;
    } else {
      out[i] = String(Number(out[i]) + 1);
      return out.join("");
    }
  }
  return `1${out.join("")}`;
}

/** Thousands separators, applied to the integer part of a decimal string. */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats an amount for display.
 *
 * The currency symbol is resolved through `Intl` using a ZERO amount, purely to
 * discover the symbol and its placement for the locale. The actual digits are
 * substituted from the decimal string, so the displayed number is exactly what
 * is stored.
 */
export function formatMoney(
  amount: MoneyString,
  currencyCode: string,
  locale = "en-US",
): string {
  const rounded = roundMoney(amount, 2);
  const negative = rounded.startsWith("-");
  const [whole, fraction] = (negative ? rounded.slice(1) : rounded).split(".");
  const digits = `${group(whole)}.${fraction}`;

  let template: string;
  try {
    template = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  } catch {
    // Unknown currency code: show the code rather than inventing a symbol.
    return `${negative ? "-" : ""}${currencyCode} ${digits}`;
  }

  // Replace the formatted zero ("0.00", "0,00", …) with our exact digits.
  const zeroDigits = template.match(/[\d][\d.,\s ]*/);
  if (!zeroDigits) return `${negative ? "-" : ""}${currencyCode} ${digits}`;

  const formatted = template.replace(zeroDigits[0], digits);
  return negative ? `-${formatted}` : formatted;
}
