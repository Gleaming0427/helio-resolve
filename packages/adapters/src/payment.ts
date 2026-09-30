import { createHash } from "node:crypto";
import type { PaymentGateway } from "@helio/application";

/** Demo provider: no money moves. Deterministic, so replays return the same refund. */
export class FakePaymentGateway implements PaymentGateway {
  async account(): Promise<string> {
    return "fake";
  }

  async refund(input: Parameters<PaymentGateway["refund"]>[0]): Promise<{ providerRefundId: string }> {
    return {
      providerRefundId: `fake_${createHash("sha256").update(`${input.paymentId.toString()}:${input.idempotencyKey}`).digest("hex")}`,
    };
  }
}
