import { describe, it, expect } from "vitest";
import {
  Approval,
  ApprovalError,
  ApprovalId,
  Order,
  Money,
  OrderId,
  PaymentId,
  RefundNotAllowed,
  TenantId,
  Ticket,
  TicketId,
  UserId,
} from "../src/index.js";

const now = new Date();

function paidOrder(daysAgo: number): Order {
  return Order.rehydrate({
    id: OrderId.of("ord_TEST123"),
    tenantId: TenantId.of("ten_TEST123"),
    status: "paid",
    total: Money.ofCents(4_900, "EUR"),
    paymentId: PaymentId.of("pay_TEST123"),
    paidAt: new Date(now.getTime() - daysAgo * 86_400_000),
  });
}

describe("Order refund rules", () => {
  it("allows a pending order without payment information", () => {
    const order = Order.rehydrate({
      id: OrderId.of("ord_TEST123"),
      tenantId: TenantId.of("ten_TEST123"),
      status: "pending",
      total: Money.ofCents(4_900, "EUR"),
      paymentId: null,
      paidAt: null,
    });
    expect(order.status).toBe("pending");
    expect(() => order.requestRefund(now)).toThrow(RefundNotAllowed);
  });

  it("should allow refund for paid orders within 30 days", () => {
    const order = paidOrder(5);
    order.requestRefund(now);
    expect(order.status).toBe("refund_pending");
  });

  it("rejects refund for paid orders after 30 days", () => {
    const order = paidOrder(31);
    expect(() => order.requestRefund(now)).toThrow(RefundNotAllowed);
  });

  it("confirms a previously request refund", () => {
    const order = paidOrder(5);
    order.requestRefund(now);
    order.confirmRefund();
    expect(order.status).toBe("refunded");
  });

  it("returns to paid when a pending refund is cancelled, allowing a new request", () => {
    const order = paidOrder(5);
    expect(() => order.cancelRefundRequest()).toThrow(RefundNotAllowed);
    order.requestRefund(now);
    order.cancelRefundRequest();
    expect(order.status).toBe("paid");
    order.requestRefund(now);
    expect(order.status).toBe("refund_pending");
  });
});

describe("Approval four-eyes control", () => {
  const proposal = () => Approval.propose({ id: ApprovalId.of("apr_TEST123"), orderId: OrderId.of("ord_TEST123"),
    tenantId: TenantId.of("ten_TEST123"), reason: "Produit abîmé", proposedBy: UserId.of("usr_AGENT123") });

  it("refuses an approval by the author of the proposal", () => {
    const approval = proposal();
    expect(() => approval.approve(UserId.of("usr_AGENT123"))).toThrow(ApprovalError);
    expect(approval.status).toBe("pending");
    approval.approve(UserId.of("usr_MANAGER123"));
    expect(approval.status).toBe("approved");
  });

  it("only rejects a pending proposal", () => {
    const approval = proposal();
    approval.reject();
    expect(approval.status).toBe("rejected");
    expect(() => approval.approve(UserId.of("usr_MANAGER123"))).toThrow(ApprovalError);
    expect(() => approval.reject()).toThrow(ApprovalError);
  });
});

describe("Ticket resolution", () => {
  it("records who resolved it, once", () => {
    const ticket = Ticket.open({ id: TicketId.of("tkt_TEST123"), tenantId: TenantId.of("ten_TEST123"),
      createdBy: UserId.of("usr_AGENT123"), subject: "Colis", body: "Colis abîmé", orderId: OrderId.of("ord_TEST123") });
    ticket.resolve(UserId.of("usr_MANAGER123"));
    expect([ticket.status, ticket.resolvedBy?.toString(), ticket.orderId?.toString()]).toEqual(["resolved", "usr_MANAGER123", "ord_TEST123"]);
    expect(() => ticket.resolve(UserId.of("usr_MANAGER123"))).toThrow("déjà résolu");
  });
});
