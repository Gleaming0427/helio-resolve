import { prisma } from "../src/prisma.js";
await prisma.order.upsert({
  where: {
    tenantId_id: {
      tenantId: "ten_DEMO123",
      id: "ord_DEMO123",
    },
  },
  create: {
    tenantId: "ten_DEMO123",
    id: "ord_DEMO123",
    status: "paid",
    totalCents: 4_900,
    currency: "EUR",
    paymentId: "pay_DEMO123",
    paidAt: new Date(Date.now() - 5 * 86_400_000),
  },
  update: {},
});
console.log("Seeded order ord_DEMO123 for tenant ten_DEMO123");
await prisma.$disconnect();
