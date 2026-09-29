import type { AuditLog } from "@helio/application";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
export class PrismaAuditLog implements AuditLog {
  constructor(private readonly db: Prisma.TransactionClient = prisma) {}

  async record(input: Parameters<AuditLog["record"]>[0]): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        tenantId: input.tenantId.toString(),
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        ...(input.metadata !== undefined
          ? { metadata: input.metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
  }
}
