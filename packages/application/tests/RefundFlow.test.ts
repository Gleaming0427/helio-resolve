import {
  ApprovalId,
  Money,
  Order,
  OrderId,
  PaymentId,
  TenantId,
} from "@helio/domain";
import { describe, expect, it } from "vitest";
import {
  ApproveAction,
  ExecuteRefund,
  GetApproval,
  ProposeRefund,
} from "../src/usecases.js";
import type {
  ApprovalRepository,
  AuditLog,
  OrderRepository,
  PaymentGateway,
  RefundExecution,
  UnitOfWork,
} from "../src/ports.js";
import type { Approval } from "@helio/domain";
class InMemoryOrders implements OrderRepository {
  private readonly values = new Map<string, Order>();
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
    this.values.set(
      `${approval.tenantId.toString()}:${approval.id.toString()}`,
      approval,
    );
  }
}
class FakePaymentGateway implements PaymentGateway {
  calls: string[] = [];
  async refund(input: Parameters<PaymentGateway["refund"]>[0]) {
    this.calls.push(input.idempotencyKey);
    return { providerRefundId: "provider_refund_123" };
  }
}
class InMemoryAudit implements AuditLog {
  readonly actions: string[] = [];
  async record(input: Parameters<AuditLog["record"]>[0]) {
    this.actions.push(input.action);
  }
}
describe("refund flow", () => {
  it("requires proposal, manager approval and explicit execution", async () => {
    const now = new Date("2026-09-27T10:00:00.000Z");
    const tenantId = TenantId.of("ten_TEST123");
    const orders = new InMemoryOrders();
    const approvals = new InMemoryApprovals();
    const payments = new FakePaymentGateway();
    const audit = new InMemoryAudit();
    orders.seed(
      Order.rehydrate({
        id: OrderId.of("ord_TEST123"),
        tenantId,
        status: "paid",
        total: Money.ofCents(4_900, "EUR"),
        paymentId: PaymentId.of("pay_TEST123"),
        paidAt: new Date(now.getTime() - 5 * 86_400_000),
      }),
    );
    // This test exercises orchestration only. Real rollback/concurrency are tested on PostgreSQL.
    const executions = new Map<string, RefundExecution>();
    const unitOfWork: UnitOfWork = {
      run: work => work({
        orders, approvals, audit,
        tickets: { findById: async () => null, save: async () => {} },
        refunds: {
          find: async (_tenantId, id) => executions.get(id.toString()) ?? null,
          create: async execution => { executions.set(execution.approvalId, execution); },
          complete: async (_tenantId, id, providerRefundId) => {
            executions.get(id.toString())!.providerRefundId = providerRefundId;
          },
          pending: async limit => [...executions.values()].filter(e => e.providerRefundId === null).slice(0, limit),
        },
      }),
    };
    const propose = new ProposeRefund(unitOfWork);
    const approve = new ApproveAction(unitOfWork);
    const execute = new ExecuteRefund(unitOfWork, payments);
    const getApproval = new GetApproval(approvals);
    const proposal = await propose.execute({
      tenantId: tenantId.toString(),
      actorId: "usr_AGENT123",
      orderId: "ord_TEST123",
      reason: "Duplicate shipment",
      now,
    });
    expect(proposal.status).toBe("pending");
    expect(await getApproval.execute({
      tenantId: tenantId.toString(),
      approvalId: proposal.approvalId,
    })).toEqual({
      id: proposal.approvalId,
      orderId: "ord_TEST123",
      reason: "Duplicate shipment",
      status: "pending",
      approvedBy: null,
    });
    expect(payments.calls).toHaveLength(0);
    await approve.execute({
      tenantId: tenantId.toString(),
      approvalId: proposal.approvalId,
      managerUserId: "usr_MANAGER1",
    });
    expect(await getApproval.execute({
      tenantId: tenantId.toString(),
      approvalId: proposal.approvalId,
    })).toMatchObject({
      status: "approved",
      approvedBy: "usr_MANAGER1",
    });
    expect(payments.calls).toHaveLength(0);
    const result = await execute.execute({
      tenantId: tenantId.toString(),
      approvalId: proposal.approvalId,
      managerUserId: "usr_MANAGER1",
    });
    expect(result.status).toBe("refunded");
    expect(payments.calls).toEqual([`refund:${tenantId.toString()}:${proposal.approvalId}`]);
    expect(audit.actions).toEqual([
      "refund.proposed",
      "approval.approved",
      "refund.executed",
    ]);
  });
});
