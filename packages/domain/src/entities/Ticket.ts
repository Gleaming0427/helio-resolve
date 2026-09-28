import { TicketId, TenantId, UserId } from "../value-objects/Ids.js";

export type TicketStatus = "open" | "resolved";

export class Ticket {
  private statusValue: TicketStatus;

  private constructor(
    public readonly id: TicketId,
    public readonly tenantId: TenantId,
    public readonly createdBy: UserId,
    public readonly subject: string,
    public readonly body: string,
    status: TicketStatus,
  ) {
    this.statusValue = status;
  }

  static open(input: {
    id: TicketId;
    tenantId: TenantId;
    createdBy: UserId;
    subject: string;
    body: string;
  }): Ticket {
    return new Ticket(
      input.id,
      input.tenantId,
      input.createdBy,
      input.subject,
      input.body,
      "open",
    );
  }

  static rehydrate(input: {
    id: TicketId;
    tenantId: TenantId;
    createdBy: UserId;
    subject: string;
    body: string;
    status: TicketStatus;
  }): Ticket {
    return new Ticket(
      input.id,
      input.tenantId,
      input.createdBy,
      input.subject,
      input.body,
      input.status,
    );
  }

  get status(): TicketStatus {
    return this.statusValue;
  }

  resolve(): void {
    if (this.statusValue !== "open") {
      throw new Error(
        `Only open tickets can be resolved. Current status: ${this.statusValue}`,
      );
    }
    this.statusValue = "resolved";
  }
}
