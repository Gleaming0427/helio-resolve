import type { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

// Fixed-window counters shared by every API instance. The database clock defines
// the window, so instances with clock drift still count in the same bucket.
export class PostgresQuotaStore {
  constructor(private readonly db: PrismaClient = prisma) {}
  async hit(key: string, windowSeconds: number): Promise<{ count: number; retryAfterSeconds: number }> {
    const rows = await this.db.$queryRaw<{ count: number; windowStart: Date; retryAfter: number }[]>`
      INSERT INTO "QuotaWindow" (key, "windowStart", count)
      VALUES (${key}, to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}::int) * ${windowSeconds}::int), 1)
      ON CONFLICT (key, "windowStart") DO UPDATE SET count = "QuotaWindow".count + 1
      RETURNING count, "windowStart",
        ceil(extract(epoch FROM "windowStart" + make_interval(secs => ${windowSeconds}::int) - now()))::int AS "retryAfter"`;
    const row = rows[0]!;
    // The first hit of a window drops the previous ones: one row per key remains.
    if (row.count === 1) await this.db.$executeRaw`DELETE FROM "QuotaWindow" WHERE key = ${key} AND "windowStart" < ${row.windowStart}`;
    return { count: row.count, retryAfterSeconds: Math.max(1, row.retryAfter) };
  }
}
export const quotaStore = new PostgresQuotaStore();
