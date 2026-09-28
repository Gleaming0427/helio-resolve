import { describe, it, expect } from "vitest";
import {
  Order,
  Money,
  OrderId,
  PaymentId,
  RefundNotAllowed,
  TenantId,
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
});
