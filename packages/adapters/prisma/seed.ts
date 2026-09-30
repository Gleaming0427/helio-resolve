import { randomBytes } from "node:crypto";
import { prisma } from "../src/prisma.js";
import { PrismaWorkspaceRepository } from "../src/workspace.js";

// Demo workspace for AUTH_MODE=dev: the administrator usr_DEMO123 (created as on a first
// login) and an agent, so that four-eyes approval can be tried locally.
const workspace = new PrismaWorkspaceRepository(prisma);
await workspace.resolveMember("usr_DEMO123", { tenantId: "ten_DEMO123", role: "tenant_admin" });
await prisma.membership.upsert({
  where: { tenantId_userId: { tenantId: "ten_DEMO123", userId: "usr_DEMOAGENT" } },
  create: { tenantId: "ten_DEMO123", userId: "usr_DEMOAGENT", email: "usr_DEMOAGENT@local.invalid", role: "support_agent" },
  update: {},
});

// Without a store, each run adds a fresh paid order so the refund journey can be replayed.
// With Shopify connected, orders come from the store instead.
const id = `ord_DEMO-${randomBytes(4).toString("hex")}`;
await prisma.order.create({
  data: {
    tenantId: "ten_DEMO123",
    id,
    status: "paid",
    totalCents: 4_900,
    currency: "EUR",
    paymentId: `pay_DEMO-${randomBytes(4).toString("hex")}`,
    paidAt: new Date(Date.now() - 5 * 86_400_000),
  },
});
console.log(`Demo workspace ten_DEMO123: administrator usr_DEMO123, agent usr_DEMOAGENT`);
console.log(`Seeded paid order ${id} (49,00 €)`);
await prisma.$disconnect();
