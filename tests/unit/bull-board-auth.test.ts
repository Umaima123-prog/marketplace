import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readBullBoardCredentials, requireBullBoardAuth } from "@/src/lib/bull-board-auth";

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function appWithGuard(): Hono {
  const app = new Hono();
  app.use("*", requireBullBoardAuth);
  app.get("/protected", (c) => c.text("ok"));
  return app;
}

describe("readBullBoardCredentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null when both variables are unset", () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "");
    vi.stubEnv("BULL_BOARD_PASSWORD", "");
    expect(readBullBoardCredentials()).toBeNull();
  });

  it("is null when only the username is set", () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "");
    expect(readBullBoardCredentials()).toBeNull();
  });

  it("is null when only the password is set", () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    expect(readBullBoardCredentials()).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "  ops  ");
    vi.stubEnv("BULL_BOARD_PASSWORD", "  secret  ");
    expect(readBullBoardCredentials()).toEqual({ username: "ops", password: "secret" });
  });

  it("returns both when both are set", () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    expect(readBullBoardCredentials()).toEqual({ username: "ops", password: "secret" });
  });
});

describe("requireBullBoardAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed with 503 when unconfigured, never falling open", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "");
    vi.stubEnv("BULL_BOARD_PASSWORD", "");
    const res = await appWithGuard().request("/protected");
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("ok");
  });

  it("fails closed with 503 when only one of the two variables is set", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "");
    const res = await appWithGuard().request("/protected");
    expect(res.status).toBe(503);
  });

  it("challenges with 401 and WWW-Authenticate when configured but no credentials are sent", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await appWithGuard().request("/protected");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("rejects the wrong password with 401", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await appWithGuard().request("/protected", {
      headers: { Authorization: basicAuthHeader("ops", "wrong") },
    });
    expect(res.status).toBe(401);
  });

  it("rejects the wrong username with 401", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await appWithGuard().request("/protected", {
      headers: { Authorization: basicAuthHeader("someone-else", "secret") },
    });
    expect(res.status).toBe(401);
  });

  it("allows the request through on correct credentials", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await appWithGuard().request("/protected", {
      headers: { Authorization: basicAuthHeader("ops", "secret") },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
