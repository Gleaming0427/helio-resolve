import "@helio/adapters/env";
import { ExecuteRefund, ResumeRefunds } from "@helio/application";
import { PrismaUnitOfWork } from "@helio/adapters/unit-of-work";
import { prisma } from "@helio/adapters/prisma";
import { payments } from "./payments.js";

try {
  const unitOfWork = new PrismaUnitOfWork();
  const recovery = new ResumeRefunds(unitOfWork, new ExecuteRefund(unitOfWork, payments));
  const results = await recovery.execute(Number(process.argv[2] ?? 100));
  for (const result of results) console.log(JSON.stringify(result));
  console.log(`Recovered ${results.filter(result => result.recovered).length}/${results.length} pending refunds`);
  if (results.some(result => !result.recovered)) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
