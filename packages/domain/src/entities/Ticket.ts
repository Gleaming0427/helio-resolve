import { DomainError } from "../errors/DomainError.js";
import { OrderId, TicketId, TenantId, UserId } from "../value-objects/Ids.js";

export type TicketStatus = "open" | "resolved";

export class Ticket {
  private statusValue: TicketStatus;
  private resolvedByValue: UserId | null;

  private constructor(
    public readonly id: TicketId,
    public readonly tenantId: TenantId,
    public readonly createdBy: UserId,
    public readonly subject: string,
    public readonly body: string,
    public readonly orderId: OrderId | null,
    status: TicketStatus,
    resolvedBy: UserId | null,
  ) {
    this.statusValue = status;
    this.resolvedByValue = resolvedBy;
  }

  static open(input: {
    id: TicketId;
    tenantId: TenantId;
    createdBy: UserId;
    subject: string;
    body: string;
    orderId?: OrderId | null;
  }): Ticket {
    return new Ticket(
      input.id,
      input.tenantId,
      input.createdBy,
      input.subject,
      input.body,
      input.orderId ?? null,
      "open",
      null,
    );
  }

  static rehydrate(input: {
    id: TicketId;
    tenantId: TenantId;
    createdBy: UserId;
    subject: string;
    body: string;
    orderId: OrderId | null;
    status: TicketStatus;
    resolvedBy: UserId | null;
  }): Ticket {
    return new Ticket(
      input.id,
      input.tenantId,
      input.createdBy,
      input.subject,
      input.body,
      input.orderId,
      input.status,
      input.resolvedBy,
    );
  }

  get status(): TicketStatus {
    return this.statusValue;
  }

  get resolvedBy(): UserId | null {
    return this.resolvedByValue;
  }

  resolve(userId: UserId): void {
    if (this.statusValue !== "open") {
      throw new DomainError("Ce ticket est déjà résolu.");
    }
    this.statusValue = "resolved";
    this.resolvedByValue = userId;
  }
}
