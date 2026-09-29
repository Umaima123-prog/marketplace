/**
 * Cart state, as pure functions.
 *
 * The cart holds VARIANT IDS AND QUANTITIES. Nothing else -- no price, no
 * title, no availability. Those are read from MySQL every time the cart is
 * displayed and again at checkout, because anything the browser stores is
 * something an attacker can edit. A cart carrying a price is a cart that can be
 * told a snowboard costs one dollar.
 *
 * Kept free of React and localStorage so the rules can be tested directly.
 */

export interface CartLine {
  variantId: string;
  quantity: number;
}

export interface CartState {
  lines: CartLine[];
}

export const EMPTY_CART: CartState = { lines: [] };

/**
 * One line may not exceed this. A bound belongs here as well as server-side:
 * this one keeps the UI honest, the server's is the one that counts.
 */
export const MAX_LINE_QUANTITY = 99;
export const MAX_CART_LINES = 50;

function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(Math.max(Math.trunc(quantity), 1), MAX_LINE_QUANTITY);
}

/** Adding an item already in the cart increases its quantity rather than duplicating the line. */
export function addLine(state: CartState, variantId: string, quantity = 1): CartState {
  if (!variantId) return state;

  const existing = state.lines.find((line) => line.variantId === variantId);
  if (existing) {
    return {
      lines: state.lines.map((line) =>
        line.variantId === variantId
          ? { ...line, quantity: clampQuantity(line.quantity + quantity) }
          : line,
      ),
    };
  }

  if (state.lines.length >= MAX_CART_LINES) return state;
  return { lines: [...state.lines, { variantId, quantity: clampQuantity(quantity) }] };
}

/** Setting a quantity of zero or less removes the line, which is what a shopper means. */
export function setQuantity(state: CartState, variantId: string, quantity: number): CartState {
  if (!Number.isFinite(quantity) || Math.trunc(quantity) < 1) {
    return removeLine(state, variantId);
  }
  return {
    lines: state.lines.map((line) =>
      line.variantId === variantId ? { ...line, quantity: clampQuantity(quantity) } : line,
    ),
  };
}

export function removeLine(state: CartState, variantId: string): CartState {
  return { lines: state.lines.filter((line) => line.variantId !== variantId) };
}

export function clearCart(): CartState {
  return EMPTY_CART;
}

/** Total item count, for the navbar badge. */
export function cartCount(state: CartState): number {
  return state.lines.reduce((total, line) => total + line.quantity, 0);
}

/**
 * Parses whatever localStorage held.
 *
 * Treated as hostile input: it is user-editable, may come from an older version
 * of this code, and may be truncated JSON. Anything unrecognisable becomes an
 * empty cart rather than an exception on first paint.
 */
export function parseCart(raw: string | null): CartState {
  if (!raw) return EMPTY_CART;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_CART;

    const lines = (parsed as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) return EMPTY_CART;

    const clean: CartLine[] = [];
    for (const entry of lines.slice(0, MAX_CART_LINES)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { variantId, quantity } = entry as Record<string, unknown>;
      if (typeof variantId !== "string" || variantId.length === 0 || variantId.length > 64) continue;
      if (typeof quantity !== "number") continue;
      if (clean.some((line) => line.variantId === variantId)) continue;
      clean.push({ variantId, quantity: clampQuantity(quantity) });
    }

    return { lines: clean };
  } catch {
    return EMPTY_CART;
  }
}

export function serializeCart(state: CartState): string {
  // Only the two fields, even if a future CartState grows more.
  return JSON.stringify({ lines: state.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) });
}
