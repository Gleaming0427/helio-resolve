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
  /** The number the customer sees in the store, e.g. #1001. */
  reference?: string | null;
};

const statusLabels: Record<OrderStatus, string> = {
  pending: "en attente de paiement",
  paid: "payée",
  refund_pending: "remboursement en attente",
  refunded: "remboursée",
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

  get reference(): string | null {
    return this.props.reference ?? null;
  }

  requestRefund(now: Date): void {
    if (this.statusValue !== "paid") {
      throw new RefundNotAllowed(
        `Seule une commande payée peut être remboursée (statut actuel : ${statusLabels[this.statusValue]}).`,
      );
    }

    if (!this.props.paidAt) {
      throw new RefundNotAllowed("La date de paiement de la commande est inconnue.");
    }

    if (now.getTime() < this.props.paidAt.getTime()) {
      throw new RefundNotAllowed("La date de paiement de la commande est dans le futur.");
    }

    const elapsedDays =
      (now.getTime() - this.props.paidAt.getTime()) / DAY_IN_MS;
    if (elapsedDays > REFUND_WINDOW_DAYS) {
      throw new RefundNotAllowed(
        `La demande dépasse le délai de remboursement de ${REFUND_WINDOW_DAYS} jours.`,
      );
    }

    this.statusValue = "refund_pending";
  }

  confirmRefund(): void {
    if (this.statusValue !== "refund_pending") {
      throw new RefundNotAllowed(
        `Aucun remboursement n’est en attente pour cette commande (statut actuel : ${statusLabels[this.statusValue]}).`,
      );
    }
    this.statusValue = "refunded";
  }

  /** A rejected proposal returns the order to paid, so a new request can be made. */
  cancelRefundRequest(): void {
    if (this.statusValue !== "refund_pending") {
      throw new RefundNotAllowed(
        `Aucun remboursement n’est en attente pour cette commande (statut actuel : ${statusLabels[this.statusValue]}).`,
      );
    }
    this.statusValue = "paid";
  }

  private assertState(): void {
    const requiresPayment = ["paid", "refunded", "refund_pending"].includes(
      this.statusValue,
    );

    if (requiresPayment && (!this.props.paymentId || !this.props.paidAt)) {
      throw new DomainError(
        "Une commande payée doit avoir un paiement et une date de paiement.",
      );
    }
  }
}
