import type { Prisma } from "@prisma/client";
import type {
  ApprovalRepository,
  OrderRepository,
  TicketRepository,
} from "@helio/application";
import {
  Approval,
  ApprovalId,
  Money,
  Order,
  OrderId,
  PaymentId,
  TenantId,
  Ticket,
  TicketId,
  UserId,
  type ApprovalStatus,
  type Currency,
  type OrderStatus,
  type TicketStatus,
} from "@helio/domain";
import { prisma } from "./prisma.js";
export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly db: Prisma.TransactionClient = prisma) {}

  async findById(tenantId: TenantId, id: OrderId): Promise<Order | null> {
    const row = await this.db.order.findUnique({
      where: {
        tenantId_id: {
          tenantId: tenantId.toString(),
          id: id.toString(),
        },
      },
    });
    if (!row) {
      return null;
    }
    return Order.rehydrate({
      id: OrderId.of(row.id),
      tenantId: TenantId.of(row.tenantId),
      status: row.status as OrderStatus,
      total: Money.ofCents(row.totalCents, row.currency as Currency),
      paymentId: row.paymentId ? PaymentId.of(row.paymentId) : null,
      paidAt: row.paidAt,
    });
  }
  async save(order: Order): Promise<void> {
    await this.db.order.upsert({
      where: {
        tenantId_id: {
          tenantId: order.tenantId.toString(),
          id: order.id.toString(),
        },
      },
      create: {
        tenantId: order.tenantId.toString(),
        id: order.id.toString(),
        status: order.status,
        totalCents: order.total.cents,
        currency: order.total.currency,
        paymentId: order.paymentId?.toString() ?? null,
        paidAt: order.paidAt,
      },
      update: {
        status: order.status,
        totalCents: order.total.cents,
        currency: order.total.currency,
        paymentId: order.paymentId?.toString() ?? null,
        paidAt: order.paidAt,
      },
    });
  }
}
export class PrismaTicketRepository implements TicketRepository {
  constructor(private readonly db: Prisma.TransactionClient = prisma) {}

  async findById(tenantId: TenantId, id: TicketId): Promise<Ticket | null> {
    const row = await this.db.ticket.findUnique({
      where: {
        tenantId_id: {
          tenantId: tenantId.toString(),
          id: id.toString(),
        },
      },
    });
    if (!row) {
      return null;
    }
    return Ticket.rehydrate({
      id: TicketId.of(row.id),
      tenantId: TenantId.of(row.tenantId),
      createdBy: UserId.of(row.createdBy),
      subject: row.subject,
      body: row.body,
      status: row.status as TicketStatus,
    });
  }
  async save(ticket: Ticket): Promise<void> {
    await this.db.ticket.upsert({
      where: {
        tenantId_id: {
          tenantId: ticket.tenantId.toString(),
          id: ticket.id.toString(),
        },
      },
      create: {
        tenantId: ticket.tenantId.toString(),
        id: ticket.id.toString(),
        createdBy: ticket.createdBy.toString(),
        subject: ticket.subject,
        body: ticket.body,
        status: ticket.status,
      },
      update: {
        status: ticket.status,
      },
    });
  }
}
export class PrismaApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Prisma.TransactionClient = prisma) {}

  async findById(tenantId: TenantId, id: ApprovalId): Promise<Approval | null> {
    const row = await this.db.approval.findUnique({
      where: {
        tenantId_id: {
          tenantId: tenantId.toString(),
          id: id.toString(),
        },
      },
    });
    if (!row) {
      return null;
    }
    return Approval.rehydrate({
      id: ApprovalId.of(row.id),
      tenantId: TenantId.of(row.tenantId),
      orderId: OrderId.of(row.orderId),
      reason: row.reason,
      status: row.status as ApprovalStatus,
      approvalBy: row.approvedBy ? UserId.of(row.approvedBy) : null,
    });
  }
  async save(approval: Approval): Promise<void> {
    await this.db.approval.upsert({
      where: {
        tenantId_id: {
          tenantId: approval.tenantId.toString(),
          id: approval.id.toString(),
        },
      },
      create: {
        tenantId: approval.tenantId.toString(),
        id: approval.id.toString(),
        orderId: approval.orderId.toString(),
        reason: approval.reason,
        status: approval.status,
        approvedBy: approval.approvalBy?.toString() ?? null,
      },
      update: {
        status: approval.status,
        approvedBy: approval.approvalBy?.toString() ?? null,
      },
    });
  }
}
