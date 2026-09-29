import { describe, expect, it, vi } from "vitest";
vi.mock("../src/env.js", () => ({}));
import { databaseUrl } from "../src/database-config.js";

const ecs = { DB_HOST: "database.internal", DB_USER: "helio", DB_PASSWORD: "secret" };

describe("shared PostgreSQL configuration", () => {
  it("prioritizes an explicit URL and preserves SSL query parameters", () => {
    const url = "postgresql://user:p%40ss@host:5432/app?sslmode=require";
    expect(databaseUrl({ ...ecs, DATABASE_URL: url, DB_PORT: "invalid" })).toBe(url);
  });
  it("supports the separate variables injected by CDK with defaults", () => {
    expect(databaseUrl(ecs)).toBe("postgresql://helio:secret@database.internal:5432/helio");
  });
  it("encodes credentials and database names without losing special characters", () => {
    const url = new URL(databaseUrl({ ...ecs, DB_USER: "user@team", DB_PASSWORD: "p@ss:/?#%$", DB_NAME: "app/name", DB_PORT: "5433" }));
    expect(decodeURIComponent(url.username)).toBe("user@team");
    expect(decodeURIComponent(url.password)).toBe("p@ss:/?#%$");
    expect(decodeURIComponent(url.pathname)).toBe("/app/name");
    expect(url.port).toBe("5433");
  });
  it.each(["::1", "[::1]"])("supports IPv6 host %s", host => {
    expect(new URL(databaseUrl({ ...ecs, DB_HOST: host })).hostname).toBe("[::1]");
  });
  it("reports missing variable names", () => {
    expect(() => databaseUrl({ DB_HOST: "host" })).toThrow("DB_USER, DB_PASSWORD");
  });
  it.each(["0", "65536", "abc", "5432.5", ""])("rejects invalid port %s", port => {
    expect(() => databaseUrl({ ...ecs, DB_PORT: port })).toThrow("DB_PORT");
  });
  it("rejects an invalid explicit URL without exposing its value", () => {
    expect(() => databaseUrl({ DATABASE_URL: "https://user:secret@host" })).toThrow(
      "DATABASE_URL must be a valid PostgreSQL connection URL",
    );
  });
});
