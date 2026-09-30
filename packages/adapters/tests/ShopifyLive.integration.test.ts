import { describe, expect, it } from "vitest";
import { TenantId } from "@helio/domain";
import { ConnectedPaymentGateway, ShopifyClient, ShopifyOrderSource, SHOPIFY_API_VERSION } from "../src/shopify.js";

// Opt-in checks against a real Shopify development store (see docs/shopify-pilot.md).
// The first block only reads. The second refunds the test order (Bogus gateway, no real
// money) and only runs with SHOPIFY_TEST_REFUND=yes.
const shop = process.env.SHOPIFY_TEST_SHOP;
const token = process.env.SHOPIFY_TEST_TOKEN;
const order = process.env.SHOPIFY_TEST_ORDER;
const refund = process.env.SHOPIFY_TEST_REFUND === "yes";

describe.skipIf(!shop || !token || !order)(`Shopify development store (API ${SHOPIFY_API_VERSION})`, () => {
  const connections = { client: async () => new ShopifyClient(shop!, token!) };

  it("grants the scopes Helio needs", async () => {
    const data = await new ShopifyClient(shop!, token!).query<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(
      "query HelioConnection { currentAppInstallation { accessScopes { handle } } }");
    expect(data.currentAppInstallation.accessScopes.map(scope => scope.handle)).toEqual(expect.arrayContaining(["read_orders", "write_orders"]));
  });

  it("reads the test order as a paid, refundable Helio order", async () => {
    const found = await new ShopifyOrderSource(connections as never).find(TenantId.of("ten_SHOPLIVE"), order!);
    expect(found).toMatchObject({ connected: true, order: expect.anything() });
    if (!found.connected || !found.order) return;
    expect(found.order.id.toString()).toMatch(/^ord_shp-\d+$/);
    expect(found.order.paymentId?.toString()).toMatch(/^pay_shp-\d+$/);
    expect(found.order.reference).toBe(order!.startsWith("#") ? order : `#${order}`);
  });
});

describe.skipIf(!shop || !token || !order || !refund)("Shopify development store refund", () => {
  const tenantId = TenantId.of("ten_SHOPLIVE");
  const connections = {
    client: async () => new ShopifyClient(shop!, token!),
    status: async () => ({ shopDomain: shop!, connectedAt: new Date(), connectedBy: "usr_LIVETEST" }),
  };

  it("refunds once, and a replay with the same key returns the same refund", async () => {
    const source = new ShopifyOrderSource(connections as never);
    const before = await source.find(tenantId, order!);
    if (!before.connected || !before.order) throw new Error("Test order not found");
    expect(before.order.status).toBe("paid");
    const gateway = new ConnectedPaymentGateway(connections as never, null);
    const input = {
      tenantId, account: await gateway.account(tenantId), orderId: before.order.id, paymentId: before.order.paymentId!,
      amount: before.order.total, idempotencyKey: `refund:ten_SHOPLIVE:apr_LIVE-${Date.now()}`,
    };
    const first = await gateway.refund(input);
    const replay = await gateway.refund(input);
    expect(replay.providerRefundId).toBe(first.providerRefundId);
    const after = await source.find(tenantId, order!);
    expect(after.connected && after.order?.status).toBe("refunded");
  }, 60_000);
});
