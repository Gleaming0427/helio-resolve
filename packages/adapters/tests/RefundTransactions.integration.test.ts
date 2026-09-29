import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { PaymentGateway, UnitOfWork } from "@helio/application";
import { ApproveAction, CreateTicket, ExecuteRefund, ProposeRefund, ResumeRefunds } from "../../application/src/usecases.js";

const url = process.env.HELIO_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/helio_refund_test") {
  throw new Error("Set HELIO_TEST_DATABASE_URL to a dedicated database named helio_refund_test; its test data will be cleared.");
}
let db: PrismaClient;
let unitOfWork: UnitOfWork;
const tenantId = "ten_TEST123";
const orderId = "ord_TEST123";
const actorId = "usr_MANAGER1";
const now = new Date("2026-09-29T10:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  ({ prisma: db } = await import("../src/prisma.js"));
  const { PrismaUnitOfWork } = await import("../src/unit-of-work.js");
  unitOfWork = new PrismaUnitOfWork(db);
  const databases = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (databases[0]?.name !== "helio_refund_test") throw new Error("Refusing non-test database");
});
afterAll(async () => { await db?.$disconnect(); });
beforeEach(async () => {
  await db.$transaction([
    db.refundExecution.deleteMany(), db.auditEvent.deleteMany(), db.approval.deleteMany(),
    db.ticket.deleteMany(), db.order.deleteMany(),
  ]);
  await db.order.create({ data: {
    tenantId, id: orderId, status: "paid", totalCents: 4900, currency: "EUR",
    paymentId: "pay_TEST123", paidAt: new Date("2026-09-28T10:00:00Z"),
  } });
});

// A provider double with durable semantics across use-case instances.
class IdempotentProvider implements PaymentGateway {
  calls: string[] = [];
  effects = new Map<string, string>();
  timeoutOnce = false;
  async refund(input: Parameters<PaymentGateway["refund"]>[0]) {
    this.calls.push(input.idempotencyKey);
    const refundId = this.effects.get(input.idempotencyKey) ?? `provider-${this.effects.size + 1}`;
    this.effects.set(input.idempotencyKey, refundId);
    if (this.timeoutOnce) {
      this.timeoutOnce = false;
      throw new Error("Response lost after provider accepted payment");
    }
    return { providerRefundId: refundId };
  }
}

function failAfterAudit(action: string): UnitOfWork {
  return {
    run: work => unitOfWork.run(tx => work({
      ...tx,
      audit: { record: async input => {
        await tx.audit.record(input);
        if (input.action === action) throw new Error("Injected persistence failure");
      } },
    })),
  };
}
const propose = (uow = unitOfWork) => new ProposeRefund(uow).execute({
  tenantId, actorId, orderId, reason: "Duplicate shipment", now,
});
async function approved() {
  const proposal = await propose();
  await new ApproveAction(unitOfWork).execute({ tenantId, approvalId: proposal.approvalId, managerUserId: actorId });
  return { tenantId, approvalId: proposal.approvalId, managerUserId: actorId };
}

describe("refund transactions on PostgreSQL", () => {
  it("rolls back the order, approval and audit when proposal persistence fails", async () => {
    await expect(propose(failAfterAudit("refund.proposed"))).rejects.toThrow("Injected");
    expect((await db.order.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: orderId } } })).status).toBe("paid");
    expect(await db.approval.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("rolls back ticket creation when its audit fails", async () => {
    await expect(new CreateTicket(failAfterAudit("ticket.created")).execute({
      tenantId, userId: actorId, subject: "Help", body: "My order",
    })).rejects.toThrow("Injected");
    expect(await db.ticket.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("rolls back approval and its audit together", async () => {
    const proposal = await propose();
    await expect(new ApproveAction(failAfterAudit("approval.approved")).execute({
      tenantId, approvalId: proposal.approvalId, managerUserId: actorId,
    })).rejects.toThrow("Injected");
    const row = await db.approval.findFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.approvedBy).toBeNull();
    expect(await db.auditEvent.count({ where: { action: "approval.approved" } })).toBe(0);
  });

  it("allows only one concurrent proposal for an order", async () => {
    const results = await Promise.allSettled([propose(), propose()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.approval.count()).toBe(1);
    expect(await db.auditEvent.count()).toBe(1);
  });

  it("does not execute a proposal before approval or on behalf of another tenant", async () => {
    const proposal = await propose();
    const provider = new IdempotentProvider();
    const execute = new ExecuteRefund(unitOfWork, provider);
    await expect(execute.execute({ tenantId, approvalId: proposal.approvalId, managerUserId: actorId })).rejects.toThrow("not approved");
    await expect(execute.execute({ tenantId: "ten_OTHER123", approvalId: proposal.approvalId, managerUserId: actorId })).rejects.toThrow("not found");
    expect(provider.calls).toHaveLength(0);
    expect(await db.refundExecution.count()).toBe(0);
  });

  it("replays a completed execution without contacting the provider or duplicating the audit", async () => {
    const input = await approved();
    const provider = new IdempotentProvider();
    const execute = new ExecuteRefund(unitOfWork, provider);
    const first = await execute.execute(input);
    expect(await execute.execute(input)).toEqual(first);
    expect(provider.calls).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { action: "refund.executed" } })).toBe(1);
    expect((await db.approval.findFirstOrThrow()).status).toBe("executed");
    expect((await db.order.findFirstOrThrow()).status).toBe("refunded");
  });

  it("keeps an intent after an ambiguous provider timeout and recovers with the same key", async () => {
    const input = await approved();
    const provider = new IdempotentProvider();
    provider.timeoutOnce = true;
    await expect(new ExecuteRefund(unitOfWork, provider).execute(input)).rejects.toThrow("Response lost");
    expect((await db.refundExecution.findFirstOrThrow()).providerRefundId).toBeNull();
    const recovered = await new ResumeRefunds(unitOfWork, new ExecuteRefund(unitOfWork, provider)).execute();
    expect(recovered).toEqual([{ tenantId, approvalId: input.approvalId, recovered: true }]);
    expect(new Set(provider.calls).size).toBe(1);
    expect(provider.effects.size).toBe(1);
    expect((await db.order.findFirstOrThrow()).status).toBe("refunded");
  });

  it("recovers after provider success followed by a database failure, preserving the original actor", async () => {
    const input = await approved();
    const provider = new IdempotentProvider();
    await expect(new ExecuteRefund(failAfterAudit("refund.executed"), provider).execute(input)).rejects.toThrow("Injected");
    expect((await db.order.findFirstOrThrow()).status).toBe("refund_pending");
    expect((await db.approval.findFirstOrThrow()).status).toBe("approved");
    expect((await db.refundExecution.findFirstOrThrow()).providerRefundId).toBeNull();
    expect(await db.auditEvent.count({ where: { action: "refund.executed" } })).toBe(0);
    await new ExecuteRefund(unitOfWork, provider).execute({ ...input, managerUserId: "usr_OTHER123" });
    expect(provider.effects.size).toBe(1);
    expect((await db.auditEvent.findFirstOrThrow({ where: { action: "refund.executed" } })).actorId).toBe(actorId);
  });

  it("finalizes concurrent executions once", async () => {
    const input = await approved();
    const provider = new IdempotentProvider();
    const execute = new ExecuteRefund(unitOfWork, provider);
    const results = await Promise.all([execute.execute(input), execute.execute(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(provider.effects.size).toBe(1);
    expect(await db.refundExecution.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "refund.executed" } })).toBe(1);
  });

  it("never recovers an approved proposal without explicit execution intent", async () => {
    await approved();
    const provider = new IdempotentProvider();
    expect(await new ResumeRefunds(unitOfWork, new ExecuteRefund(unitOfWork, provider)).execute()).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});
