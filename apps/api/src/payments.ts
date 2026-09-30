import { ConnectedPaymentGateway, FakePaymentGateway, ShopifyConnections } from "@helio/adapters";

export const shopifyConnections = new ShopifyConnections();
// API and recovery MUST use the same gateway: each intent records the account it runs on.
// The simulated provider serves demo tenants without a store, never in production.
export const payments = new ConnectedPaymentGateway(
  shopifyConnections,
  process.env.NODE_ENV === "production" ? null : new FakePaymentGateway(),
);
