import {
  Approval,
  ApprovalId,
  DomainError,
  OrderId,
  PaymentId,
  TenantId,
  Ticket,
  TicketId,
  UserId,
} from "@helio/domain";
import type {
  ApprovalRepository,
  AuditLog,
  KnowledgeIngestion,
  OrderRepository,
  PaymentGateway,
  UnitOfWork,
} from "./ports.js";

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
      id: order.id.toString(),
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
      id: approval.id.toString(),
      orderId: approval.orderId.toString(),
      reason: approval.reason,
      status: approval.status,
      approvedBy: approval.approvalBy?.toString() ?? null,
    };
  }
}

export class CreateTicket {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(input: {
    tenantId: string;
    userId: string;
    subject: string;
    body: string;
  }) {
    return this.unitOfWork.run(async (tx) => {
      const ticket = Ticket.open({
        id: TicketId.of(randomId("tkt")),
        tenantId: TenantId.of(input.tenantId),
        createdBy: UserId.of(input.userId),
        subject: input.subject,
        body: input.body,
      });

      await tx.tickets.save(ticket);
      await tx.audit.record({
        tenantId: TenantId.of(input.tenantId),
        actorId: input.userId,
        action: "ticket.created",
        resourceType: "ticket",
        resourceId: ticket.id.toString(),
      });

      return {
        id: ticket.id.toString(),
        status: ticket.status,
      };
    });
  }
}

export class ProposeRefund {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(input: {
    tenantId: string;
    actorId: string;
    orderId: string;
    reason: string;
    now?: Date;
  }) {
    return this.unitOfWork.run(async (tx) => {
      const tenantId = TenantId.of(input.tenantId);
      const order = await tx.orders.findById(
        tenantId,
        OrderId.of(input.orderId),
      );

      if (!order) {
        throw new DomainError("Order not found");
      }

      order.requestRefund(input.now ?? new Date());

      const approval = Approval.propose({
        id: ApprovalId.of(randomId("apr")),
        tenantId,
        orderId: order.id,
        reason: input.reason,
      });

      await tx.orders.save(order);
      await tx.approvals.save(approval);
      await tx.audit.record({
        tenantId: TenantId.of(input.tenantId),
        actorId: input.actorId,
        action: "refund.proposed",
        resourceType: "approval",
        resourceId: approval.id.toString(),
        metadata: { orderId: order.id.toString() },
      });

      return {
        approvalId: approval.id.toString(),
        status: approval.status,
      };
    });
  }
}

export class ApproveAction {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(input: {
    tenantId: string;
    approvalId: string;
    managerUserId: string;
  }) {
    return this.unitOfWork.run(async (tx) => {
      const tenantId = TenantId.of(input.tenantId);
      const approval = await tx.approvals.findById(
        tenantId,
        ApprovalId.of(input.approvalId),
      );

      if (!approval) {
        throw new DomainError("Approval not found");
      }

      approval.approve(UserId.of(input.managerUserId));
      await tx.approvals.save(approval);
      await tx.audit.record({
        tenantId: TenantId.of(input.tenantId),
        actorId: input.managerUserId,
        action: "approval.approved",
        resourceType: "approval",
        resourceId: approval.id.toString(),
      });

      return {
        approvalId: approval.id.toString(),
        status: approval.status,
      };
    });
  }
}

export class ExecuteRefund {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly payments: PaymentGateway,
  ) {}

  async execute(input: {
    tenantId: string;
    approvalId: string;
    managerUserId: string;
  }) {
    const tenantId = TenantId.of(input.tenantId);
    const approvalId = ApprovalId.of(input.approvalId);
    const actorId = UserId.of(input.managerUserId).toString();

    // Commit the intent before contacting the provider. A pending intent can be replayed.
    const execution = await this.unitOfWork.run(async (tx) => {
      const existing = await tx.refunds.find(tenantId, approvalId);
      if (existing) return existing;
      const approval = await tx.approvals.findById(tenantId, approvalId);
      if (!approval) throw new DomainError("Approval not found");
      if (approval.status !== "approved") throw new DomainError("Approval is not approved");
      const order = await tx.orders.findById(tenantId, approval.orderId);
      if (!order) throw new DomainError("Order not found");
      if (order.status !== "refund_pending" || !order.paymentId) {
        throw new DomainError("Order is not ready for refund");
      }
      const intent = {
        tenantId: tenantId.toString(),
        approvalId: approvalId.toString(),
        orderId: order.id.toString(),
        paymentId: order.paymentId.toString(),
        actorId,
        idempotencyKey: `refund:${tenantId.toString()}:${approvalId.toString()}`,
        providerRefundId: null,
      };
      await tx.refunds.create(intent);
      return intent;
    });

    if (execution.providerRefundId !== null) {
      return { status: "refunded" as const, providerRefundId: execution.providerRefundId };
    }

    // Never hold a database transaction open during a network call.
    // An ambiguous timeout leaves the intent pending; retry uses the persisted key.
    const refund = await this.payments.refund({
      paymentId: PaymentId.of(execution.paymentId),
      idempotencyKey: execution.idempotencyKey,
    });
    if (!refund.providerRefundId) throw new DomainError("Payment provider returned no refund identifier");

    return this.unitOfWork.run(async (tx) => {
      const current = await tx.refunds.find(tenantId, approvalId);
      if (!current) throw new DomainError("Refund execution not found");
      if (current.providerRefundId !== null) {
        return { status: "refunded" as const, providerRefundId: current.providerRefundId };
      }
      const approval = await tx.approvals.findById(tenantId, approvalId);
      const order = await tx.orders.findById(tenantId, OrderId.of(current.orderId));
      if (!approval || !order) throw new DomainError("Refund state not found");
      order.confirmRefund();
      approval.markExecuted();
      await tx.orders.save(order);
      await tx.approvals.save(approval);
      await tx.audit.record({
        tenantId,
        actorId: current.actorId,
        action: "refund.executed",
        resourceType: "order",
        resourceId: current.orderId,
        metadata: { approvalId: current.approvalId, providerRefundId: refund.providerRefundId },
      });
      await tx.refunds.complete(tenantId, approvalId, refund.providerRefundId);
      return { status: "refunded" as const, providerRefundId: refund.providerRefundId };
    });
  }
}

/** Operator-triggered recovery: never executes approvals without a persisted intent. */
export class ResumeRefunds {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly executeRefund: ExecuteRefund,
  ) {}

  async execute(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError("Recovery limit must be between 1 and 1000");
    }
    const pending = await this.unitOfWork.run(tx => tx.refunds.pending(limit));
    const results: { tenantId: string; approvalId: string; recovered: boolean }[] = [];
    for (const intent of pending) {
      try {
        await this.executeRefund.execute({
          tenantId: intent.tenantId,
          approvalId: intent.approvalId,
          managerUserId: intent.actorId,
        });
        results.push({ tenantId: intent.tenantId, approvalId: intent.approvalId, recovered: true });
      } catch {
        results.push({ tenantId: intent.tenantId, approvalId: intent.approvalId, recovered: false });
      }
    }
    return results;
  }
}

export class SubmitKnowledgeDocument {
  constructor(
    private readonly ingestion: KnowledgeIngestion,
    private readonly audit: AuditLog,
  ) {}

  async execute(input: {
    tenantId: string;
    actorId: string;
    title: string;
    text: string;
  }) {
    const result = await this.ingestion.submit({
      tenantId: TenantId.of(input.tenantId),
      title: input.title,
      text: input.text,
    });

    await this.audit.record({
      tenantId: TenantId.of(input.tenantId),
      actorId: input.actorId,
      action: "knowledge.submitted",
      resourceType: "knowledge_document",
      resourceId: result.documentKey,
      metadata: { title: input.title },
    });
    return {
      status: "queued" as const,
      documentKey: result.documentKey,
    };
  }
}
