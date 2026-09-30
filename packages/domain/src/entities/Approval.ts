import { ApprovalError } from "../errors/ApprovalError.js";
import { ApprovalId, OrderId, TenantId, UserId } from "../value-objects/Ids.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed";

export class Approval {
  private statusValue: ApprovalStatus;
  private approvalByValue: UserId | null;
  private constructor(
    public readonly id: ApprovalId,
    public readonly orderId: OrderId,
    public readonly tenantId: TenantId,
    public readonly reason: string,
    status: ApprovalStatus,
    approvalBy: UserId | null,
    /** Null only for proposals made before the author was recorded. */
    public readonly proposedBy: UserId | null,
  ) {
    this.statusValue = status;
    this.approvalByValue = approvalBy;
  }

  static propose(input: {
    id: ApprovalId;
    orderId: OrderId;
    tenantId: TenantId;
    reason: string;
    proposedBy: UserId;
  }): Approval {
    return new Approval(
      input.id,
      input.orderId,
      input.tenantId,
      input.reason,
      "pending",
      null,
      input.proposedBy,
    );
  }

  static rehydrate(input: {
    id: ApprovalId;
    orderId: OrderId;
    tenantId: TenantId;
    status: ApprovalStatus;
    reason: string;
    approvalBy: UserId | null;
    proposedBy: UserId | null;
  }): Approval {
    return new Approval(
      input.id,
      input.orderId,
      input.tenantId,
      input.reason,
      input.status,
      input.approvalBy,
      input.proposedBy,
    );
  }

  get status(): ApprovalStatus {
    return this.statusValue;
  }

  get approvalBy(): UserId | null {
    return this.approvalByValue;
  }

  approve(userId: UserId): void {
    if (this.statusValue !== "pending") {
      throw new ApprovalError(
        "Seule une proposition en attente peut être approuvée.",
      );
    }
    // Four-eyes control: the author of a refund proposal cannot approve it.
    if (this.proposedBy?.equals(userId)) {
      throw new ApprovalError(
        "Vous avez fait cette proposition : une autre personne doit l’approuver.",
      );
    }
    this.statusValue = "approved";
    this.approvalByValue = userId;
  }

  reject(): void {
    if (this.statusValue !== "pending") {
      throw new ApprovalError(
        "Seule une proposition en attente peut être refusée.",
      );
    }
    this.statusValue = "rejected";
  }

  markExecuted(): void {
    if (this.statusValue !== "approved") {
      throw new ApprovalError(
        "Seule une proposition approuvée peut être exécutée.",
      );
    }
    this.statusValue = "executed";
  }
}
