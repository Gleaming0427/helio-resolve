import { DomainError } from "../errors/DomainError.js";

export type Currency = "USD" | "EUR";

export class Money {
  private constructor(
    public readonly cents: number,
    public readonly currency: Currency,
  ) {}

  static ofCents(cents: number, currency: Currency): Money {
    if (!Number.isInteger(cents) || cents < 0) {
      throw new DomainError("Money must be a non-negative integer");
    }
    return new Money(cents, currency);
  }

  toDecimal(): number {
    return this.cents / 100;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this.currency === other.currency;
  }
}
