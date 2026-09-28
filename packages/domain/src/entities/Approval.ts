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
    status: ApprovalStatus,
    approvalBy: UserId | null,
  ) {
    this.statusValue = status;
    this.approvalByValue = approvalBy;
  }

  static propose(input: {
    id: ApprovalId;
    orderId: OrderId;
    tenantId: TenantId;
    reason: string;
  }): Approval {
    return new Approval(
      input.id,
      input.orderId,
      input.tenantId,
      "pending",
      null,
    );
  }

  static rehydrate(input: {
    id: ApprovalId;
    orderId: OrderId;
    tenantId: TenantId;
    status: ApprovalStatus;
    approvalBy: UserId | null;
  }): Approval {
    return new Approval(
      input.id,
      input.orderId,
      input.tenantId,
      input.status,
      input.approvalBy,
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
        "Approval can only be approved when it is pending.",
      );
    }
    this.statusValue = "approved";
    this.approvalByValue = userId;
  }

  reject(): void {
    if (this.statusValue !== "pending") {
      throw new ApprovalError(
        "Approval can only be rejected when it is pending.",
      );
    }
    this.statusValue = "rejected";
  }

  markExecuted(): void {
    if (this.statusValue !== "approved") {
      throw new ApprovalError(
        "Approval can only be marked as executed when it is approved.",
      );
    }
    this.statusValue = "executed";
  }
}
