import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { PostgresQuotaStore } from "../src/quota.js";

const url = process.env.HELIO_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/helio_refund_test") throw new Error("A dedicated helio_refund_test database is required.");
const a = "chat:ten_QUOTAA", b = "chat:ten_QUOTAB";
let db: PrismaClient, first: PostgresQuotaStore, second: PostgresQuotaStore;
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  ({ prisma: db } = await import("../src/prisma.js"));
  const { PostgresQuotaStore } = await import("../src/quota.js");
  // Two stores stand for two API instances sharing the database.
  first = new PostgresQuotaStore(db); second = new PostgresQuotaStore(db);
});
beforeEach(async () => { await db.quotaWindow.deleteMany({ where: { key: { in: [a, b] } } }); });
afterAll(async () => { await db?.$disconnect(); });

it("counts concurrent hits from several instances in one tenant bucket", async () => {
  const hits = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? second : first).hit(a, 3600)));
  expect(hits.map(hit => hit.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  for (const hit of hits) expect(hit.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  for (const hit of hits) expect(hit.retryAfterSeconds).toBeLessThanOrEqual(3600);
  expect((await first.hit(b, 3600)).count).toBe(1);
});

it("starts a new window and drops the previous counters", async () => {
  await db.quotaWindow.create({ data: { key: a, windowStart: new Date(Date.now() - 2 * 3600_000), count: 999 } });
  expect((await first.hit(a, 3600)).count).toBe(1);
  expect(await db.quotaWindow.count({ where: { key: a } })).toBe(1);
});
