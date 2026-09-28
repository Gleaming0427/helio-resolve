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

export class GetApproval {
  constructor(private readonly approvals: ApprovalRepository) {}

  async execute(input: { tenantId: string; approvalId: string }) {
    const approval = await this.approvals.findById(
      TenantId.of(input.tenantId),
      ApprovalId.of(input.approvalId),
    );

    if (!approval) {
      throw new DomainError("Approval not found");
    }

    return {
      id: approval.id.value,
      orderId: approval.orderId.value,
      reason: approval.reason,
      status: approval.status,
      approvedBy: approval.approvedBy?.value ?? null,
    };
  }
}

export class CreateTicket {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly audit: AuditLog,
  ) {}

  async execute(input: {
    tenantId: string;
    userId: string;
    subject: string;
    body: string;
  }) {
    const ticket = Ticket.open({
      id: TicketId.of(randomId("tkt")),
      TenantId: TenantId.of(input.tenantId),
      createdBy: UserId.of(input.userId),
      subject: input.subject,
      body: input.body,
    });

    await this.tickets.save(ticket);
    await this.audit.record({
      tenantId: input.tenantId,
      actorId: input.userId,
      action: "ticket.created",
      resourceType: "ticket",
      resourceId: ticket.id.value,
    });

    return {
      id: ticket.id.value,
      status: ticket.status,
    };
  }
}

export class ProposeRefund {
  constructor(
    private readonly orders: OrderRepository,
    private readonly approvals: ApprovalRepository,
    private readonly audit: AuditLog,
  ) {}

  async execute(input: {
    tenantId: string;
    actorId: string;
    orderId: string;
    reason: string;
    now?: Date;
  }) {
    const tenantId = TenantId.of(input.tenantId);
    const order = await this.orders.findById(
      tenantId,
      OrderId.of(input.orderId),
    );

    if (!order) {
      throw new DomainError("Order not found");
    }

    order.requestRefund(input.now ?? new Date());

    const approval = Approval.propose({
      id: ApprovalId(randomId("apr")),
      tenantId,
      orderId: order.id,
      reason: input.reason,
    });

    await this.orders.save(order);
    await this.approvals.save(approval);
    await this.audit.record({
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: "refund.proposed",
      resourceType: "approval",
      resourceId: approval.id.value,
      metadata: { orderId: order.id.value },
    });

    return {
      ApprovalId: approval.id.value,
      status: approval.status,
    };
  }
}

export class ApproveAction {
  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly audit: AuditLog,
  ) {}

  async execute(input: {
    tenantId: string;
    approvalId: string;
    managerUserId: string;
  }) {
    const tenantId = TenantId.of(input.tenantId);
    const approval = await this.approvals.findById(
      tenantId,
      ApprovalId.of(input.approvalId),
    );

    if (!approval) {
      throw new DomainError("Approval not found");
    }

    approval.approve(UserId.of(input.managerUserId));
    await this.approvals.save(approval);
    await this.audit.record({
      tenantId: input.tenantId,
      actorId: input.managerUserId,
      action: "approval.approved",
      resourceType: "approval",
      resourceId: approval.id.value,
    });

    return {
      ApprovalId: approval.id.value,
      status: approval.status,
    };
  }
}
