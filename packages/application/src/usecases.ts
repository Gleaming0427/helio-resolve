import {
  Approval,
  ApprovalId,
  type ApprovalStatus,
  DomainError,
  Money,
  type Currency,
  Order,
  OrderId,
  PaymentId,
  RefundRejected,
  TenantId,
  Ticket,
  TicketId,
  type TicketStatus,
  UserId,
} from "@helio/domain";
import type {
  ApprovalRepository,
  OrderRepository,
  OrderSource,
  PaymentGateway,
  RefundExecutionRepository,
  TicketRepository,
  UnitOfWork,
} from "./ports.js";

function randomId(prefix: string): string {
  const randomPort = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `${prefix}_${randomPort}`;
}

function orderView(order: Order) {
  return {
    id: order.id.toString(),
    reference: order.reference,
    status: order.status,
    totalCents: order.total.cents,
    currency: order.total.currency,
    paidAt: order.paidAt?.toISOString() ?? null,
  };
}

/** Brings the connected store's version of an order into Helio and returns its Helio id.
 * Without a store, the reference must already be a Helio order id. */
export class OrderResolver {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly source?: OrderSource,
  ) {}

  async resolve(tenantId: TenantId, reference: string): Promise<OrderId> {
    const found = this.source ? await this.source.find(tenantId, reference) : { connected: false as const };
    if (!found.connected) {
      try {
        return OrderId.of(reference);
      } catch {
        throw new DomainError(`Aucune boutique n’est connectée : un administrateur doit connecter Shopify dans Réglages pour retrouver la commande « ${reference.slice(0, 40)} ».`);
      }
    }
    const snapshot = found.order;
    if (!snapshot) throw new DomainError("Commande introuvable dans la boutique connectée.");
    await this.unitOfWork.run(async (tx) => {
      const local = await tx.orders.findById(tenantId, snapshot.id);
      // Once a refund is requested, Helio owns the order's state until it completes.
      if (!local || local.status === "pending" || local.status === "paid") {
        await tx.orders.save(snapshot);
      }
    });
    return snapshot.id;
  }
}

export class GetOrderContext {
  constructor(
    private readonly orders: OrderRepository,
    private readonly resolver: OrderResolver,
  ) {}

  async execute(input: { tenantId: string; orderId: string }) {
    const tenantId = TenantId.of(input.tenantId);
    const order = await this.orders.findById(tenantId, await this.resolver.resolve(tenantId, input.orderId));
    if (!order) {
      throw new DomainError("Commande introuvable.");
    }
    return orderView(order);
  }
}

export class GetApproval {
  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly orders: OrderRepository,
    private readonly executions: Pick<RefundExecutionRepository, "find">,
  ) {}

  async execute(input: { tenantId: string; approvalId: string }) {
    const tenantId = TenantId.of(input.tenantId);
    const approvalId = ApprovalId.of(input.approvalId);
    const approval = await this.approvals.findById(tenantId, approvalId);
    if (!approval) {
      throw new DomainError("Proposition de remboursement introuvable.");
    }
    const order = await this.orders.findById(tenantId, approval.orderId);
    const execution = await this.executions.find(tenantId, approvalId);
    return {
      ...approvalView(approval),
      order: order ? orderView(order) : null,
      execution: execution && {
        status: execution.providerRefundId ? "refunded" as const : execution.failureReason ? "failed" as const : "pending" as const,
        providerRefundId: execution.providerRefundId,
        failureReason: execution.failureReason,
      },
    };
  }
}

function approvalView(approval: Approval) {
  return {
    id: approval.id.toString(),
    orderId: approval.orderId.toString(),
    reason: approval.reason,
    status: approval.status,
    proposedBy: approval.proposedBy?.toString() ?? null,
    approvedBy: approval.approvalBy?.toString() ?? null,
  };
}

/** The manager's queue: proposals to review and approved ones awaiting execution. */
export class ListApprovals {
  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly orders: OrderRepository,
  ) {}

  async execute(input: { tenantId: string; statuses: ApprovalStatus[] }) {
    const tenantId = TenantId.of(input.tenantId);
    const approvals = await this.approvals.list(tenantId, input.statuses, 50);
    return Promise.all(approvals.map(async approval => {
      const order = await this.orders.findById(tenantId, approval.orderId);
      return { ...approvalView(approval), order: order ? orderView(order) : null };
    }));
  }
}

export class CreateTicket {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly resolver: OrderResolver,
  ) {}
  async execute(input: {
    tenantId: string;
    userId: string;
    subject: string;
    body: string;
    orderId?: string | undefined;
  }) {
    const tenantId = TenantId.of(input.tenantId);
    const orderId = input.orderId ? await this.resolver.resolve(tenantId, input.orderId) : null;
    return this.unitOfWork.run(async (tx) => {
      if (orderId && !await tx.orders.findById(tenantId, orderId)) {
        throw new DomainError("Commande introuvable.");
      }
      const ticket = Ticket.open({
        id: TicketId.of(randomId("tkt")),
        tenantId,
        createdBy: UserId.of(input.userId),
        subject: input.subject,
        body: input.body,
        orderId,
      });

      await tx.tickets.save(ticket);
      await tx.audit.record({
        tenantId,
        actorId: input.userId,
        action: "ticket.created",
        resourceType: "ticket",
        resourceId: ticket.id.toString(),
        ...(orderId ? { metadata: { orderId: orderId.toString() } } : {}),
      });

      return {
        id: ticket.id.toString(),
        status: ticket.status,
      };
    });
  }
}

function ticketView(ticket: Ticket) {
  return {
    id: ticket.id.toString(),
    subject: ticket.subject,
    body: ticket.body,
    status: ticket.status,
    orderId: ticket.orderId?.toString() ?? null,
    createdBy: ticket.createdBy.toString(),
    resolvedBy: ticket.resolvedBy?.toString() ?? null,
  };
}

export class ListTickets {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly orders: OrderRepository,
  ) {}

  async execute(input: { tenantId: string; status: TicketStatus | null }) {
    const tenantId = TenantId.of(input.tenantId);
    const tickets = await this.tickets.list(tenantId, input.status, 100);
    return Promise.all(tickets.map(async ticket => ({
      ...ticketView(ticket),
      orderReference: ticket.orderId ? (await this.orders.findById(tenantId, ticket.orderId))?.reference ?? null : null,
    })));
  }
}

export class ResolveTicket {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: { tenantId: string; ticketId: string; userId: string }) {
    const tenantId = TenantId.of(input.tenantId);
    return this.unitOfWork.run(async (tx) => {
      const ticket = await tx.tickets.findById(tenantId, TicketId.of(input.ticketId));
      if (!ticket) throw new DomainError("Ticket introuvable.");
      ticket.resolve(UserId.of(input.userId));
      await tx.tickets.save(ticket);
      await tx.audit.record({
        tenantId,
        actorId: input.userId,
        action: "ticket.resolved",
        resourceType: "ticket",
        resourceId: ticket.id.toString(),
      });
      return ticketView(ticket);
    });
  }
}

export class ProposeRefund {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly resolver: OrderResolver,
  ) {}
  async execute(input: {
    tenantId: string;
    actorId: string;
    orderId: string;
    reason: string;
    now?: Date;
  }) {
    const tenantId = TenantId.of(input.tenantId);
    const orderId = await this.resolver.resolve(tenantId, input.orderId);
    return this.unitOfWork.run(async (tx) => {
      const order = await tx.orders.findById(tenantId, orderId);

      if (!order) {
        throw new DomainError("Commande introuvable.");
      }

      order.requestRefund(input.now ?? new Date());

      const approval = Approval.propose({
        id: ApprovalId.of(randomId("apr")),
        tenantId,
        orderId: order.id,
        reason: input.reason,
        proposedBy: UserId.of(input.actorId),
      });

      await tx.orders.save(order);
      await tx.approvals.save(approval);
      await tx.audit.record({
        tenantId,
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
        throw new DomainError("Proposition de remboursement introuvable.");
      }

      approval.approve(UserId.of(input.managerUserId));
      await tx.approvals.save(approval);
      await tx.audit.record({
        tenantId,
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

export class RejectApproval {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(input: {
    tenantId: string;
    approvalId: string;
    managerUserId: string;
  }) {
    return this.unitOfWork.run(async (tx) => {
      const tenantId = TenantId.of(input.tenantId);
      const approval = await tx.approvals.findById(tenantId, ApprovalId.of(input.approvalId));
      if (!approval) throw new DomainError("Proposition de remboursement introuvable.");
      const order = await tx.orders.findById(tenantId, approval.orderId);
      if (!order) throw new DomainError("Commande introuvable.");
      approval.reject();
      // The order becomes refundable again: a corrected proposal can be made.
      order.cancelRefundRequest();
      await tx.approvals.save(approval);
      await tx.orders.save(order);
      await tx.audit.record({
        tenantId,
        actorId: input.managerUserId,
        action: "approval.rejected",
        resourceType: "approval",
        resourceId: approval.id.toString(),
        metadata: { orderId: order.id.toString() },
      });
      return { approvalId: approval.id.toString(), status: approval.status };
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
    // Only a new intent needs the current account: a replay uses the one it recorded.
    const account = await this.payments.account(tenantId).then(value => ({ value }), (error: unknown) => ({ error }));

    // Commit the intent before contacting the provider. A pending intent can be replayed.
    const execution = await this.unitOfWork.run(async (tx) => {
      const existing = await tx.refunds.find(tenantId, approvalId);
      if (existing) return existing;
      if ("error" in account) throw account.error;
      const approval = await tx.approvals.findById(tenantId, approvalId);
      if (!approval) throw new DomainError("Proposition de remboursement introuvable.");
      if (approval.status !== "approved") throw new DomainError("La proposition doit être approuvée avant l’exécution.");
      const order = await tx.orders.findById(tenantId, approval.orderId);
      if (!order) throw new DomainError("Commande introuvable.");
      if (order.status !== "refund_pending" || !order.paymentId) {
        throw new DomainError("La commande n’est pas prête pour un remboursement.");
      }
      const intent = {
        tenantId: tenantId.toString(),
        approvalId: approvalId.toString(),
        orderId: order.id.toString(),
        paymentId: order.paymentId.toString(),
        actorId,
        idempotencyKey: `refund:${tenantId.toString()}:${approvalId.toString()}`,
        account: account.value,
        amountCents: order.total.cents,
        currency: order.total.currency,
        providerRefundId: null,
        failureReason: null,
      };
      await tx.refunds.create(intent);
      return intent;
    });

    if (execution.providerRefundId !== null) {
      return { status: "refunded" as const, providerRefundId: execution.providerRefundId };
    }
    if (execution.failureReason !== null) {
      throw new RefundRejected(execution.failureReason);
    }

    // Never hold a database transaction open during a network call.
    // An ambiguous timeout leaves the intent pending; retry uses the persisted key and account.
    let refund: { providerRefundId: string };
    try {
      refund = await this.payments.refund({
        tenantId,
        account: execution.account,
        orderId: OrderId.of(execution.orderId),
        paymentId: PaymentId.of(execution.paymentId),
        amount: Money.ofCents(execution.amountCents, execution.currency as Currency),
        idempotencyKey: execution.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof RefundRejected) await this.recordRefusal(tenantId, approvalId, execution.actorId, error.message);
      throw error;
    }
    if (!refund.providerRefundId) throw new DomainError("Le prestataire n’a renvoyé aucune référence de remboursement.");

    return this.unitOfWork.run(async (tx) => {
      const current = await tx.refunds.find(tenantId, approvalId);
      if (!current) throw new DomainError("Exécution du remboursement introuvable.");
      if (current.providerRefundId !== null) {
        return { status: "refunded" as const, providerRefundId: current.providerRefundId };
      }
      const approval = await tx.approvals.findById(tenantId, approvalId);
      const order = await tx.orders.findById(tenantId, OrderId.of(current.orderId));
      if (!approval || !order) throw new DomainError("État du remboursement introuvable.");
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

  private async recordRefusal(tenantId: TenantId, approvalId: ApprovalId, actorId: string, reason: string) {
    await this.unitOfWork.run(async (tx) => {
      const current = await tx.refunds.find(tenantId, approvalId);
      if (!current || current.providerRefundId !== null || current.failureReason !== null) return;
      await tx.refunds.fail(tenantId, approvalId, reason);
      await tx.audit.record({
        tenantId,
        actorId,
        action: "refund.failed",
        resourceType: "order",
        resourceId: current.orderId,
        metadata: { approvalId: current.approvalId, reason },
      });
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
