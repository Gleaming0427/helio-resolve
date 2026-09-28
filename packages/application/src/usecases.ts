import {
  Approval,
  ApprovalId,
  DomainError,
  OrderId,
  TenantId,
  Ticket,
  TicketId,
  UserId,
} from "@helio/domain";
import type {
  ApprovalRepository,
  AuditLog,
  knowledgeIngestion,
  OrderRepository,
  PaymentGateway,
  TicketRepository,
} from "./ports";

function randomId(prefix: string): string {
  const randomPort = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `${prefix}_${randomPort}`;
}

export class GetOrderContext {
  constructor(private readonly orders: OrderRepository) {}

  async execute(input: { tenantId: string; orderId: string }) {
    const order = await this.orders.findById(
      TenantId.of(input.tenantId),
      OrderId.of(input.orderId),
    );

    if (!order) {
      throw new DomainError("Order not found");
    }

    return {
      id: order.id.value,
      status: order.status,
      totalCents: order.total.cents,
      currency: order.total.currency,
      paidAt: order.paidAt?.toISOString() ?? null,
    };
  }
}

export class GetApproval {}
