import { afterEach, beforeEach, expect, it, vi } from "vitest";

const constructors = vi.hoisted(() => ({ prismaPg: vi.fn(), pool: vi.fn() }));
vi.mock("../src/env.js", () => ({}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class { constructor(config: unknown) { constructors.prismaPg(config); } },
}));
vi.mock("@prisma/client", () => ({ PrismaClient: class {} }));
vi.mock("pg", () => ({
  Pool: class { constructor(config: unknown) { constructors.pool(config); } },
}));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

it.each(["separate variables", "explicit URL"])("initializes Prisma and knowledge with the same connection using %s", async mode => {
  vi.stubEnv("DATABASE_URL", mode === "explicit URL" ? "postgresql://user:password@localhost/test?sslmode=require" : undefined);
  vi.stubEnv("DB_HOST", "database.internal");
  vi.stubEnv("DB_PORT", "5432");
  vi.stubEnv("DB_USER", "helio");
  vi.stubEnv("DB_PASSWORD", "secret");
  vi.stubEnv("DB_NAME", "helio");
  await import("../src/prisma.js");
  await import("../src/knowledge.js");
  const expected = mode === "explicit URL"
    ? "postgresql://user:password@localhost/test?sslmode=require"
    : "postgresql://helio:secret@database.internal:5432/helio";
  expect(constructors.prismaPg).toHaveBeenCalledWith({ connectionString: expected });
  expect(constructors.pool).toHaveBeenCalledWith({ connectionString: expected });
});
