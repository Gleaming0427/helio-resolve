import { DomainError } from "../errors/DomainError.js";
import { RefundNotAllowed } from "../errors/RefundNotAllowed.js";
import { OrderId, TenantId, PaymentId } from "../value-objects/Ids.js";
import { Money } from "../value-objects/Money.js";

export type OrderStatus = "pending" | "paid" | "refunded" | "refund_pending";

export type OrderProps = {
  id: OrderId;
  tenantId: TenantId;
  status: OrderStatus;
  total: Money;
  paymentId: PaymentId | null;
  paidAt: Date | null;
};

const DAY_IN_MS = 86_400_000; // 24 hours in milliseconds
const REFUND_WINDOW_DAYS = 30; // Refund window in days

export class Order {
  private statusValue: OrderStatus;

  private constructor(private readonly props: OrderProps) {
    this.statusValue = props.status;
    this.assertState();
  }

  static rehydrate(props: OrderProps): Order {
    return new Order(props);
  }

  get id(): OrderId {
    return this.props.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get status(): OrderStatus {
    return this.statusValue;
  }

  get total(): Money {
    return this.props.total;
  }

  get paymentId(): PaymentId | null {
    return this.props.paymentId;
  }

  get paidAt(): Date | null {
    return this.props.paidAt;
  }

  requestRefund(now: Date): void {
    if (this.statusValue !== "paid") {
      throw new RefundNotAllowed(
        `Only paid orders can be refunded. Current status: ${this.statusValue}`,
      );
    }

    if (!this.props.paidAt) {
      throw new RefundNotAllowed("Paid date is missing for the order.");
    }

    if (now.getTime() < this.props.paidAt.getTime()) {
      throw new RefundNotAllowed("Paid date is in the future.");
    }

    const elapsedDays =
      (now.getTime() - this.props.paidAt.getTime()) / DAY_IN_MS;
    if (elapsedDays > REFUND_WINDOW_DAYS) {
      throw new RefundNotAllowed(
        `Refund request is outside the allowed window of ${REFUND_WINDOW_DAYS} days.`,
      );
    }

    this.statusValue = "refund_pending";
  }

  confirmRefund(): void {
    if (this.statusValue !== "refund_pending") {
      throw new RefundNotAllowed(
        `Only orders with a pending refund can be confirmed. Current status: ${this.statusValue}`,
      );
    }
    this.statusValue = "refunded";
  }

  private assertState(): void {
    const requiresPayment = ["paid", "refunded", "refund_pending"].includes(
      this.statusValue,
    );

    if (requiresPayment && (!this.props.paymentId || !this.props.paidAt)) {
      throw new DomainError(
        "Paid orders must have a paymentId and paidAt date.",
      );
    }
  }
}
