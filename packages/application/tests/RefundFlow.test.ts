import {
  ApprovalId,
  Money,
  Order,
  OrderId,
  PaymentId,
  RefundRejected,
  TenantId,
  type Approval,
  type OrderStatus,
} from "@helio/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ApproveAction,
  ExecuteRefund,
  GetApproval,
  OrderResolver,
  ProposeRefund,
  RejectApproval,
  ResumeRefunds,
} from "../src/usecases.js";
import type {
  ApprovalRepository,
  AuditLog,
  OrderRepository,
  OrderSource,
  PaymentGateway,
  RefundExecution,
  UnitOfWork,
} from "../src/ports.js";

// These tests exercise orchestration only. Real rollback/concurrency are tested on PostgreSQL.
class InMemoryOrders implements OrderRepository {
  readonly values = new Map<string, Order>();
  seed(order: Order): void {
    this.values.set(`${order.tenantId.toString()}:${order.id.toString()}`, order);
  }
  async findById(tenantId: TenantId, id: OrderId) {
    return this.values.get(`${tenantId.toString()}:${id.toString()}`) ?? null;
  }
  async save(order: Order): Promise<void> {
    this.seed(order);
  }
}
class InMemoryApprovals implements ApprovalRepository {
  private readonly values = new Map<string, Approval>();
  async findById(tenantId: TenantId, id: ApprovalId) {
    return this.values.get(`${tenantId.toString()}:${id.toString()}`) ?? null;
  }
  async save(approval: Approval): Promise<void> {
    this.values.set(`${approval.tenantId.toString()}:${approval.id.toString()}`, approval);
  }
  async list() {
    return [...this.values.values()];
  }
}
class RecordingGateway implements PaymentGateway {
  calls: { account: string; key: string; cents: number }[] = [];
  currentAccount = "shopify:helio-test.myshopify.com";
  refusal: string | null = null;
  async account() {
    return this.currentAccount;
  }
  async refund(input: Parameters<PaymentGateway["refund"]>[0]) {
    this.calls.push({ account: input.account, key: input.idempotencyKey, cents: input.amount.cents });
    if (this.refusal) throw new RefundRejected(this.refusal);
    return { providerRefundId: "provider_refund_123" };
  }
}
class InMemoryAudit implements AuditLog {
  readonly actions: string[] = [];
  async record(input: Parameters<AuditLog["record"]>[0]) {
    this.actions.push(input.action);
  }
}

const now = new Date("2026-09-27T10:00:00.000Z");
const tenantId = TenantId.of("ten_TEST123");
const order = (status: OrderStatus = "paid", id = "ord_TEST123") => Order.rehydrate({
  id: OrderId.of(id), tenantId, status, total: Money.ofCents(4_900, "EUR"),
  paymentId: status === "pending" ? null : PaymentId.of("pay_TEST123"),
  paidAt: status === "pending" ? null : new Date(now.getTime() - 5 * 86_400_000),
});

let orders: InMemoryOrders, approvals: InMemoryApprovals, payments: RecordingGateway, audit: InMemoryAudit;
let executions: Map<string, RefundExecution>, unitOfWork: UnitOfWork, resolver: OrderResolver;
beforeEach(() => {
  orders = new InMemoryOrders();
  approvals = new InMemoryApprovals();
  payments = new RecordingGateway();
  audit = new InMemoryAudit();
  executions = new Map();
  unitOfWork = {
    run: work => work({
      orders, approvals, audit,
      tickets: { findById: async () => null, save: async () => {}, list: async () => [] },
      refunds: {
        find: async (_tenantId, id) => executions.get(id.toString()) ?? null,
        create: async execution => { executions.set(execution.approvalId, { ...execution }); },
        complete: async (_tenantId, id, providerRefundId) => { executions.get(id.toString())!.providerRefundId = providerRefundId; },
        fail: async (_tenantId, id, reason) => { executions.get(id.toString())!.failureReason = reason; },
        pending: async limit => [...executions.values()].filter(e => e.providerRefundId === null && e.failureReason === null).slice(0, limit),
      },
    }),
  };
  resolver = new OrderResolver(unitOfWork);
  orders.seed(order());
});
const input = (approvalId: string, managerUserId = "usr_MANAGER1") => ({ tenantId: tenantId.toString(), approvalId, managerUserId });
async function approvedProposal() {
  const proposal = await new ProposeRefund(unitOfWork, resolver).execute({
    tenantId: tenantId.toString(), actorId: "usr_AGENT123", orderId: "ord_TEST123", reason: "Duplicate shipment", now,
  });
  await new ApproveAction(unitOfWork).execute(input(proposal.approvalId));
  return proposal.approvalId;
}

describe("refund flow", () => {
  it("requires proposal, approval by another person and explicit execution", async () => {
    const getApproval = new GetApproval(approvals, orders, { find: async (_t, id) => executions.get(id.toString()) ?? null });
    const proposal = await new ProposeRefund(unitOfWork, resolver).execute({
      tenantId: tenantId.toString(), actorId: "usr_AGENT123", orderId: "ord_TEST123", reason: "Duplicate shipment", now,
    });
    expect(await getApproval.execute(input(proposal.approvalId))).toEqual({
      id: proposal.approvalId, orderId: "ord_TEST123", reason: "Duplicate shipment", status: "pending",
      proposedBy: "usr_AGENT123", approvedBy: null, execution: null,
      order: { id: "ord_TEST123", reference: null, status: "refund_pending", totalCents: 4_900, currency: "EUR", paidAt: expect.any(String) },
    });
    await expect(new ApproveAction(unitOfWork).execute(input(proposal.approvalId, "usr_AGENT123"))).rejects.toThrow("une autre personne");
    await new ApproveAction(unitOfWork).execute(input(proposal.approvalId));
    expect(payments.calls).toHaveLength(0);
    const result = await new ExecuteRefund(unitOfWork, payments).execute(input(proposal.approvalId));
    expect(result.status).toBe("refunded");
    expect(payments.calls).toEqual([{ account: "shopify:helio-test.myshopify.com", key: `refund:ten_TEST123:${proposal.approvalId}`, cents: 4_900 }]);
    expect((await getApproval.execute(input(proposal.approvalId))).execution).toEqual({ status: "refunded", providerRefundId: "provider_refund_123", failureReason: null });
    expect(audit.actions).toEqual(["refund.proposed", "approval.approved", "refund.executed"]);
  });

  it("returns a rejected proposal's order to paid so it can be proposed again", async () => {
    const proposal = await new ProposeRefund(unitOfWork, resolver).execute({
      tenantId: tenantId.toString(), actorId: "usr_AGENT123", orderId: "ord_TEST123", reason: "Wrong order", now,
    });
    await new RejectApproval(unitOfWork).execute(input(proposal.approvalId));
    expect((await orders.findById(tenantId, OrderId.of("ord_TEST123")))!.status).toBe("paid");
    await expect(new ApproveAction(unitOfWork).execute(input(proposal.approvalId))).rejects.toThrow("en attente");
    await expect(new ExecuteRefund(unitOfWork, payments).execute(input(proposal.approvalId))).rejects.toThrow("approuvée");
    await new ProposeRefund(unitOfWork, resolver).execute({
      tenantId: tenantId.toString(), actorId: "usr_AGENT123", orderId: "ord_TEST123", reason: "Correct order", now,
    });
    expect(audit.actions).toEqual(["refund.proposed", "approval.rejected", "refund.proposed"]);
    expect(payments.calls).toEqual([]);
  });

  it("records a definitive refusal once and never retries it", async () => {
    const approvalId = await approvedProposal();
    payments.refusal = "Shopify a refusé le remboursement : montant supérieur au remboursable";
    const execute = new ExecuteRefund(unitOfWork, payments);
    await expect(execute.execute(input(approvalId))).rejects.toThrow(RefundRejected);
    await expect(execute.execute(input(approvalId))).rejects.toThrow("montant supérieur");
    expect(payments.calls).toHaveLength(1);
    expect(await new ResumeRefunds(unitOfWork, execute).execute()).toEqual([]);
    expect(audit.actions.filter(action => action === "refund.failed")).toHaveLength(1);
    expect((await orders.findById(tenantId, OrderId.of("ord_TEST123")))!.status).toBe("refund_pending");
  });

  it("replays an intent on the account it started on, even if the store changes", async () => {
    const approvalId = await approvedProposal();
    const failing: PaymentGateway = { account: payments.account.bind(payments), refund: async () => { throw new Error("Response lost"); } };
    await expect(new ExecuteRefund(unitOfWork, failing).execute(input(approvalId))).rejects.toThrow("Response lost");
    payments.currentAccount = "shopify:another-shop.myshopify.com";
    await new ExecuteRefund(unitOfWork, payments).execute(input(approvalId));
    expect(payments.calls.map(call => call.account)).toEqual(["shopify:helio-test.myshopify.com"]);
  });

  it("does not need a connected account to replay a completed refund", async () => {
    const approvalId = await approvedProposal();
    const first = await new ExecuteRefund(unitOfWork, payments).execute(input(approvalId));
    const disconnected: PaymentGateway = { account: async () => { throw new Error("Aucune boutique connectée"); }, refund: payments.refund.bind(payments) };
    expect(await new ExecuteRefund(unitOfWork, disconnected).execute(input(approvalId))).toEqual(first);
    expect(payments.calls).toHaveLength(1);
  });
});

describe("order resolution from the connected store", () => {
  const source = (found: Order | null): OrderSource => ({ find: async () => ({ connected: true, order: found }) });

  it("uses Helio's records when no store is connected", async () => {
    expect((await resolver.resolve(tenantId, "ord_TEST123")).toString()).toBe("ord_TEST123");
    await expect(resolver.resolve(tenantId, "#1001")).rejects.toThrow("connecter Shopify");
  });

  it("imports a new store order and refreshes one Helio has not started refunding", async () => {
    await new OrderResolver(unitOfWork, source(order("paid", "ord_shp-1001"))).resolve(tenantId, "#1001");
    expect((await orders.findById(tenantId, OrderId.of("ord_shp-1001")))!.status).toBe("paid");
    // Refunded directly in the store: Helio must not offer another refund.
    await new OrderResolver(unitOfWork, source(order("refunded", "ord_shp-1001"))).resolve(tenantId, "#1001");
    expect((await orders.findById(tenantId, OrderId.of("ord_shp-1001")))!.status).toBe("refunded");
  });

  it("keeps Helio's state once a refund is in progress", async () => {
    orders.seed(order("refund_pending", "ord_shp-1002"));
    await new OrderResolver(unitOfWork, source(order("paid", "ord_shp-1002"))).resolve(tenantId, "#1002");
    expect((await orders.findById(tenantId, OrderId.of("ord_shp-1002")))!.status).toBe("refund_pending");
  });

  it("reports an order missing from the store", async () => {
    await expect(new OrderResolver(unitOfWork, source(null)).resolve(tenantId, "#9999")).rejects.toThrow("introuvable dans la boutique");
  });
});
