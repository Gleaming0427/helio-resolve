import type {
  RefundExecution, RefundExecutionRepository, TransactionContext, UnitOfWork,
} from "@helio/application";
import type { ApprovalId, TenantId } from "@helio/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { PrismaAuditLog } from "./audit.js";
import { PrismaApprovalRepository, PrismaOrderRepository, PrismaTicketRepository } from "./repositories.js";
import { prisma } from "./prisma.js";

export class PrismaRefundExecutions implements RefundExecutionRepository {
  constructor(private readonly db: Prisma.TransactionClient = prisma) {}

  find(tenantId: TenantId, approvalId: ApprovalId): Promise<RefundExecution | null> {
    return this.db.refundExecution.findUnique({
      where: { tenantId_approvalId: { tenantId: tenantId.toString(), approvalId: approvalId.toString() } },
    });
  }

  async create(execution: RefundExecution): Promise<void> {
    await this.db.refundExecution.create({ data: execution });
  }

  async complete(tenantId: TenantId, approvalId: ApprovalId, providerRefundId: string): Promise<void> {
    await this.db.refundExecution.update({
      where: { tenantId_approvalId: { tenantId: tenantId.toString(), approvalId: approvalId.toString() } },
      data: { providerRefundId },
    });
  }

  async fail(tenantId: TenantId, approvalId: ApprovalId, reason: string): Promise<void> {
    await this.db.refundExecution.update({
      where: { tenantId_approvalId: { tenantId: tenantId.toString(), approvalId: approvalId.toString() } },
      data: { failureReason: reason.slice(0, 1000) },
    });
  }

  pending(limit: number): Promise<RefundExecution[]> {
    return this.db.refundExecution.findMany({
      where: { providerRefundId: null, failureReason: null },
      orderBy: [{ createdAt: "asc" }, { tenantId: "asc" }, { approvalId: "asc" }],
      take: limit,
    });
  }
}

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly db: PrismaClient = prisma) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.$transaction(async db => work({
          orders: new PrismaOrderRepository(db),
          approvals: new PrismaApprovalRepository(db),
          tickets: new PrismaTicketRepository(db),
          audit: new PrismaAuditLog(db),
          refunds: new PrismaRefundExecutions(db),
        }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        // Concurrent creation of the same intent can also produce a unique-key conflict.
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === "P2034" || error.code === "P2002");
        if (!retryable || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }
}
