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
      reference: row.reference,
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
        reference: order.reference,
      },
      update: {
        status: order.status,
        totalCents: order.total.cents,
        currency: order.total.currency,
        paymentId: order.paymentId?.toString() ?? null,
        paidAt: order.paidAt,
        reference: order.reference,
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
    return row ? ticketFrom(row) : null;
  }
  async list(tenantId: TenantId, status: TicketStatus | null, limit: number): Promise<Ticket[]> {
    const rows = await this.db.ticket.findMany({
      where: { tenantId: tenantId.toString(), ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(ticketFrom);
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
        orderId: ticket.orderId?.toString() ?? null,
      },
      update: {
        status: ticket.status,
        resolvedBy: ticket.resolvedBy?.toString() ?? null,
        resolvedAt: ticket.status === "resolved" ? new Date() : null,
      },
    });
  }
}
function ticketFrom(row: { id: string; tenantId: string; createdBy: string; subject: string; body: string; status: string; orderId: string | null; resolvedBy: string | null }) {
  return Ticket.rehydrate({
    id: TicketId.of(row.id),
    tenantId: TenantId.of(row.tenantId),
    createdBy: UserId.of(row.createdBy),
    subject: row.subject,
    body: row.body,
    orderId: row.orderId ? OrderId.of(row.orderId) : null,
    status: row.status as TicketStatus,
    resolvedBy: row.resolvedBy ? UserId.of(row.resolvedBy) : null,
  });
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
    return row ? approvalFrom(row) : null;
  }
  async list(tenantId: TenantId, statuses: ApprovalStatus[], limit: number): Promise<Approval[]> {
    const rows = await this.db.approval.findMany({
      where: { tenantId: tenantId.toString(), status: { in: statuses } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map(approvalFrom);
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
        proposedBy: approval.proposedBy?.toString() ?? null,
        approvedBy: approval.approvalBy?.toString() ?? null,
      },
      update: {
        status: approval.status,
        approvedBy: approval.approvalBy?.toString() ?? null,
      },
    });
  }
}
function approvalFrom(row: { id: string; tenantId: string; orderId: string; reason: string; status: string; proposedBy: string | null; approvedBy: string | null }) {
  return Approval.rehydrate({
    id: ApprovalId.of(row.id),
    tenantId: TenantId.of(row.tenantId),
    orderId: OrderId.of(row.orderId),
    reason: row.reason,
    status: row.status as ApprovalStatus,
    proposedBy: row.proposedBy ? UserId.of(row.proposedBy) : null,
    approvalBy: row.approvedBy ? UserId.of(row.approvedBy) : null,
  });
}
