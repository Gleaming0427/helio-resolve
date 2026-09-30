import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { UnitOfWork } from "@helio/application";
import { RefundRejected, TenantId, TicketId } from "@helio/domain";
import {
  ApproveAction, CreateTicket, ExecuteRefund, OrderResolver, ProposeRefund, RejectApproval, ResumeRefunds,
} from "../../application/src/usecases.js";
import type { ConnectedPaymentGateway, ShopifyConnections } from "../src/shopify.js";
import { LocalSecretCipher } from "../src/secrets.js";
import { FakeShopify } from "./support/fakeShopify.js";

// The pilot journey against a Shopify double: store connection, order sync, proposal,
// four-eyes approval, execution with lost responses and replays, and refusals.
const url = process.env.HELIO_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/helio_refund_test") throw new Error("A dedicated helio_refund_test database is required.");
const tenantId = "ten_SHOPJOURNEY";
const shop = "helio-test.myshopify.com";
const agent = "usr_AGENT1", manager = "usr_MANAGER1", admin = "usr_ADMIN1";
const fake = new FakeShopify();
const cipher = new LocalSecretCipher(randomBytes(32).toString("base64"));
let db: PrismaClient, unitOfWork: UnitOfWork, connections: ShopifyConnections, gateway: ConnectedPaymentGateway, resolver: OrderResolver;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  ({ prisma: db } = await import("../src/prisma.js"));
  const { PrismaUnitOfWork } = await import("../src/unit-of-work.js");
  const shopify = await import("../src/shopify.js");
  await fake.start();
  unitOfWork = new PrismaUnitOfWork(db);
  connections = new shopify.ShopifyConnections(db, () => cipher, fake.endpoint);
  gateway = new shopify.ConnectedPaymentGateway(connections, null);
  resolver = new OrderResolver(unitOfWork, new shopify.ShopifyOrderSource(connections));
});
afterAll(async () => { await fake.stop(); await db?.$disconnect(); });
beforeEach(async () => {
  fake.reset();
  fake.addOrder({ number: 1001 });
  const scope = { where: { tenantId } };
  await db.$transaction([
    db.refundExecution.deleteMany(scope), db.auditEvent.deleteMany(scope), db.approval.deleteMany(scope),
    db.ticket.deleteMany(scope), db.order.deleteMany(scope), db.shopifyConnection.deleteMany(scope),
  ]);
  await connections.connect({ tenantId, actorId: admin, shopDomain: shop, accessToken: fake.token });
});

const propose = (orderId = "#1001") => new ProposeRefund(unitOfWork, resolver).execute({ tenantId, actorId: agent, orderId, reason: "Produit reçu cassé" });
const execute = () => new ExecuteRefund(unitOfWork, gateway);
async function approvedProposal() {
  const { approvalId } = await propose();
  await new ApproveAction(unitOfWork).execute({ tenantId, approvalId, managerUserId: manager });
  return { tenantId, approvalId, managerUserId: manager };
}
const localOrder = () => db.order.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: "ord_shp-1001" } } });
const count = (action: string) => db.auditEvent.count({ where: { tenantId, action } });

it("connects a store only with a valid token and the order scopes, and stores the token encrypted", async () => {
  await expect(connections.connect({ tenantId, actorId: admin, shopDomain: shop, accessToken: `shpat_${"0".repeat(32)}` })).rejects.toThrow("jeton");
  fake.scopes = ["read_orders"];
  await expect(connections.connect({ tenantId, actorId: admin, shopDomain: shop, accessToken: fake.token })).rejects.toThrow("write_orders");
  const row = await db.shopifyConnection.findUniqueOrThrow({ where: { tenantId } });
  expect(row.tokenCiphertext).not.toContain(fake.token);
  expect(await cipher.decrypt(row.tokenCiphertext, tenantId)).toBe(fake.token);
  // Bound to the tenant: a ciphertext copied to another company cannot be read there.
  await expect(cipher.decrypt(row.tokenCiphertext, "ten_OTHER123")).rejects.toThrow();
});

it("runs the pilot journey once, despite a lost response and replays", async () => {
  const { approvalId } = await propose();
  expect(await localOrder()).toMatchObject({ reference: "#1001", status: "refund_pending", totalCents: 2500, currency: "EUR", paymentId: "pay_shp-6001" });
  await expect(new ApproveAction(unitOfWork).execute({ tenantId, approvalId, managerUserId: agent })).rejects.toThrow("une autre personne");
  await new ApproveAction(unitOfWork).execute({ tenantId, approvalId, managerUserId: manager });

  // Shopify commits the refund but the response never arrives.
  fake.loseNextRefundResponse();
  await expect(execute().execute({ tenantId, approvalId, managerUserId: manager })).rejects.toThrow("sans risque de doublon");
  expect(await db.refundExecution.findFirstOrThrow({ where: { tenantId } })).toMatchObject({ providerRefundId: null, account: `shopify:${shop}`, amountCents: 2500 });

  expect(await new ResumeRefunds(unitOfWork, execute()).execute()).toContainEqual({ tenantId, approvalId, recovered: true });
  const replay = await execute().execute({ tenantId, approvalId, managerUserId: manager });
  expect(replay.providerRefundId).toMatch(/^gid:\/\/shopify\/Refund\//);
  expect(fake.orders.get(1001)!.refunds).toHaveLength(1);
  expect(fake.refundCreateCalls).toBe(1);
  expect((await localOrder()).status).toBe("refunded");
  expect(await count("refund.executed")).toBe(1);
  // Now refunded in Shopify too: no second proposal.
  await expect(propose()).rejects.toThrow("remboursée");
});

it("lets Shopify's idempotency key absorb concurrent executions", async () => {
  const input = await approvedProposal();
  const results = await Promise.all([execute().execute(input), execute().execute(input)]);
  expect(results[0]).toEqual(results[1]);
  expect(fake.orders.get(1001)!.refunds).toHaveLength(1);
  expect(await count("refund.executed")).toBe(1);
});

it("finds an earlier refund by its note once Shopify has forgotten the key", async () => {
  const input = await approvedProposal();
  fake.loseNextRefundResponse();
  await expect(execute().execute(input)).rejects.toThrow();
  fake.forgetKeys();
  await execute().execute(input);
  expect(fake.orders.get(1001)!.refunds).toHaveLength(1);
  expect(fake.refundCreateCalls).toBe(1);
});

it("records a definitive refusal and never retries it", async () => {
  const input = await approvedProposal();
  fake.refuseNextRefund("Refund amount exceeds the refundable amount");
  await expect(execute().execute(input)).rejects.toThrow(RefundRejected);
  await expect(execute().execute(input)).rejects.toThrow("exceeds the refundable amount");
  expect(await new ResumeRefunds(unitOfWork, execute()).execute()).not.toContainEqual(expect.objectContaining({ tenantId }));
  expect(fake.refundCreateCalls).toBe(1);
  expect(fake.orders.get(1001)!.refunds).toHaveLength(0);
  expect(await count("refund.failed")).toBe(1);
});

it("keeps a refund in progress on the store where it started", async () => {
  const input = await approvedProposal();
  fake.loseNextRefundResponse();
  await expect(execute().execute(input)).rejects.toThrow();
  await expect(connections.connect({ tenantId, actorId: admin, shopDomain: "another-shop.myshopify.com", accessToken: fake.token })).rejects.toThrow("en cours");
  await expect(connections.disconnect(tenantId, admin)).rejects.toThrow("en cours");
  await execute().execute(input);
  await connections.disconnect(tenantId, admin);
  expect(await count("shopify.disconnected")).toBe(1);
});

it("returns a rejected proposal's order to paid, then accepts a corrected one", async () => {
  const { approvalId } = await propose();
  await new RejectApproval(unitOfWork).execute({ tenantId, approvalId, managerUserId: manager });
  expect((await localOrder()).status).toBe("paid");
  await propose();
  expect(fake.refundCreateCalls).toBe(0);
});

it("reports orders Shopify does not know or that Helio must not handle", async () => {
  await expect(propose("#9999")).rejects.toThrow("introuvable dans la boutique");
  fake.addOrder({ number: 1002, financial: "PARTIALLY_REFUNDED" });
  await expect(propose("#1002")).rejects.toThrow("PARTIALLY_REFUNDED");
  fake.addOrder({ number: 1003, processedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  await expect(propose("#1003")).rejects.toThrow("30 jours");
});

it("links a ticket to the Shopify order", async () => {
  const { id } = await new CreateTicket(unitOfWork, resolver).execute({ tenantId, userId: agent, subject: "Colis abîmé", body: "Photo reçue", orderId: "#1001" });
  const { PrismaTicketRepository } = await import("../src/repositories.js");
  const ticket = await new PrismaTicketRepository(db).findById(TenantId.of(tenantId), TicketId.of(id));
  expect(ticket?.orderId?.toString()).toBe("ord_shp-1001");
});
