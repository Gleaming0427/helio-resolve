import { createHash } from "node:crypto";
import type { PaymentGateway } from "@helio/application";
export class FakePaymentGateway implements PaymentGateway {
  async refund(input: {
    paymentId: Parameters<PaymentGateway["refund"]>[0]["paymentId"];
    idempotencyKey: string;
  }): Promise<{ providerRefundId: string }> {
    return {
      providerRefundId: `fake_${createHash("sha256").update(`${input.paymentId.toString()}:${input.idempotencyKey}`).digest("hex")}`,
    };
  }
}
