/**
 * HTTP Basic Auth gate for the Bull Board monitor, and nothing else.
 *
 * Deliberately NOT part of `./env`: those variables are validated once at
 * import and a missing one stops the whole process from booting, which is
 * right for DATABASE_URL and wrong here -- an operator who hasn't set
 * BULL_BOARD_USERNAME/PASSWORD yet must still get a working storefront, just
 * with the dashboard locked. So this reads `process.env` itself, at request
 * time, and the credentials are read fresh on every request rather than
 * cached -- cheap for a low-traffic internal dashboard, and it means setting
 * both variables takes effect without a rebuild.
 */
import { basicAuth } from "hono/basic-auth";
import type { Context, MiddlewareHandler, Next } from "hono";

export function readBullBoardCredentials(): { username: string; password: string } | null {
  const username = process.env.BULL_BOARD_USERNAME?.trim();
  const password = process.env.BULL_BOARD_PASSWORD?.trim();
  if (!username || !password) return null;
  return { username, password };
}

/**
 * Denies every request when BULL_BOARD_USERNAME or BULL_BOARD_PASSWORD is
 * unset -- the dashboard fails closed, never open, and the response says so
 * without echoing anything from the request or the environment.
 *
 * When both are set, delegates to Hono's own `basicAuth`, which compares with
 * `timingSafeEqual` and never logs or reflects the credentials it checks.
 */
export const requireBullBoardAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const credentials = readBullBoardCredentials();
  if (!credentials) {
    return c.text(
      "Bull Board is not configured: set BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD.",
      503,
    );
  }

  return basicAuth({
    username: credentials.username,
    password: credentials.password,
    realm: "Bull Board",
  })(c, next);
};
