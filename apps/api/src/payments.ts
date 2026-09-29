import { FakePaymentGateway } from "@helio/adapters/payment";

// API and recovery MUST use the same provider/account and idempotency semantics.
// This project currently runs with a simulated payment provider.
export const payments = new FakePaymentGateway();
