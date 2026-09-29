"use client";

/**
 * The guest cart: React state over localStorage.
 *
 * There is no cart table and no session. A guest cart is a list of
 * `{ variantId, quantity }` pairs in the shopper's own browser, and that is the
 * whole of it -- see `src/lib/cart/cart-state.ts` for the reducer, which is pure
 * and holds every rule about what a cart may contain.
 *
 * It stores NO price. Not as a cache, not as a hint. Storing one would create a
 * second answer to "what does this cost", and the wrong one would be the one the
 * customer saw. Prices come from `/api/cart/hydrate`, which reads MySQL.
 *
 * localStorage is an external store, so it is read through
 * `useSyncExternalStore` rather than copied into state by an effect. That is not
 * a stylistic preference: the effect version renders an empty cart first and
 * corrects it a tick later, and React 19 rejects the synchronous `setState` in an
 * effect that it needs. Here the snapshot IS the stored string, hydration is
 * handled by the server snapshot, and cross-tab updates are just another
 * notification.
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import {
  addLine,
  cartCount,
  clearCart,
  parseCart,
  removeLine,
  serializeCart,
  setQuantity,
  type CartState,
} from "@/src/lib/cart/cart-state";

const STORAGE_KEY = "marketplace.cart.v1";

/**
 * Same-tab writes do not fire `storage` -- that event is for OTHER tabs only --
 * so writes announce themselves with this.
 */
const LOCAL_CHANGE_EVENT = "marketplace:cart-changed";

/**
 * localStorage throws rather than returning null in Safari private mode and
 * wherever site data is blocked. A shopper with storage disabled gets a cart that
 * does not survive a reload, which is a degraded storefront; an uncaught
 * exception here would be a blank one.
 */
function readStorage(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Quota exceeded or storage disabled. Nothing to do: the notification below
    // still re-renders from whatever the store now holds.
  }
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(LOCAL_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(LOCAL_CHANGE_EVENT, onStoreChange);
  };
}

/**
 * The snapshot is the raw string, which is a primitive and therefore stable under
 * `Object.is` -- returning a freshly parsed object here would make every check
 * look like a change and loop.
 */
function getSnapshot(): string {
  return readStorage();
}

/**
 * `undefined` marks "not read yet". The client snapshot is always a string, so
 * `undefined` distinguishes the server render and the hydration render from a
 * genuinely empty cart, which is what `ready` reports.
 */
function getServerSnapshot(): string | undefined {
  return undefined;
}

interface CartContextValue {
  cart: CartState;
  /** Number of items, not lines: 3 of one variant is 3. */
  count: number;
  /**
   * False on the server render and during hydration. The badge renders no number
   * until it is true: rendering 0 and correcting it is a flicker on every page
   * load, and during hydration it would be a mismatch.
   */
  ready: boolean;
  add: (variantId: string, quantity?: number) => void;
  update: (variantId: string, quantity: number) => void;
  remove: (variantId: string) => void;
  clear: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Parsed once per distinct stored string, not once per render: `cart` is a
  // dependency of the hydration effect downstream, and a new object every render
  // would re-fetch prices forever.
  const cart = useMemo(() => parseCart(raw ?? null), [raw]);

  /**
   * Every mutation writes storage; the re-render comes back through the store.
   * There is no second copy of the cart in React state to drift from it.
   */
  const apply = useCallback(
    (next: (current: CartState) => CartState) => {
      writeStorage(serializeCart(next(cart)));
    },
    [cart],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      count: cartCount(cart),
      ready: raw !== undefined,
      add: (variantId, quantity = 1) => apply((current) => addLine(current, variantId, quantity)),
      update: (variantId, quantity) => apply((current) => setQuantity(current, variantId, quantity)),
      remove: (variantId) => apply((current) => removeLine(current, variantId)),
      clear: () => apply(() => clearCart()),
    }),
    [apply, cart, raw],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside <CartProvider>");
  return context;
}
