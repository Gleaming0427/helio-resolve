import { DomainError } from "../errors/DomainError.js";

abstract class StringId {
  protected constructor(protected readonly value: string) {}

  equals(other: StringId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

function validate(prefix: string, value: string): string {
  const normalized = value.trim();
  const regex = new RegExp(`^${prefix}_[a-zA-Z0-9-]{6,64}$`);

  if (!regex.test(normalized)) {
    throw new DomainError(`Invalid ${prefix} format: ${value}`);
  }

  return normalized;
}

export class OrderId extends StringId {
  private constructor(value: string) {
    super(value);
  }

  static of(value: string): OrderId {
    return new OrderId(validate("ord", value));
  }
}

export class PaymentId extends StringId {
  private constructor(value: string) {
    super(value);
  }

  static of(value: string): PaymentId {
    return new PaymentId(validate("pay", value));
  }
}

export class TicketId extends StringId {
  private constructor(value: string) {
    super(value);
  }

  static of(value: string): TicketId {
    return new TicketId(validate("tkt", value));
  }
}

export class ApprovalId extends StringId {
  private constructor(value: string) {
    super(value);
  }

  static of(value: string): ApprovalId {
    return new ApprovalId(validate("apr", value));
  }
}

export class TenantId extends StringId {
  private constructor(value: string) {
    super(value);
  }

  static of(value: string): TenantId {
    return new TenantId(validate("ten", value));
  }
}

export class UserId extends StringId {
  private constructor(value: string) {
    super(value);
  }

  static of(value: string): UserId {
    return new UserId(validate("usr", value));
  }
}
