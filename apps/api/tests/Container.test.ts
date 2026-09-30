import { beforeEach, expect, it, vi } from "vitest";

// The model chooses tool names and arguments: the tenant and actor must come from
// the authenticated context only, whatever the model writes.
const mocks = vi.hoisted(() => ({ settings: vi.fn(), agent: vi.fn() }));
vi.mock("@helio/adapters", () => ({
  BedrockSupportAgent: class { constructor(...args: unknown[]) { mocks.agent(...args); } },
  PgVectorKnowledgeSearch: class {},
  PrismaApprovalRepository: class {},
  PrismaOrderRepository: class {},
  PrismaRefundExecutions: class {},
  PrismaTicketRepository: class {},
  PrismaUnitOfWork: class {},
  ShopifyOrderSource: class {},
  prisma: { tenantSettings: { findUniqueOrThrow: mocks.settings } },
}));
vi.mock("../src/payments.js", () => ({ payments: {}, shopifyConnections: {} }));
import { createAgent, useCases } from "../src/container.js";

const context = { tenantId: "ten_TEST123", userId: "usr_AGENT123" };
const injected = { tenantId: "ten_OTHER123", userId: "usr_OTHER123", actorId: "usr_OTHER123" };
async function tools() {
  await createAgent(context);
  return mocks.agent.mock.calls.at(-1)![1] as (name: string, input: unknown) => Promise<unknown>;
}
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.settings.mockResolvedValue({ locale: "en-US", responseTone: "concise" });
});

it("reads the settings of the authenticated tenant", async () => {
  await createAgent(context);
  expect(mocks.settings).toHaveBeenCalledWith({ where: { tenantId: "ten_TEST123" } });
  expect(mocks.agent.mock.calls.at(-1)![2]).toEqual({ locale: "en-US", responseTone: "concise" });
});

it.each([
  ["get_order", "getOrder", { orderId: "ord_TEST123" }, { tenantId: "ten_TEST123", orderId: "ord_TEST123" }],
  ["create_ticket", "createTicket", { subject: "Colis", body: "Colis abîmé" }, { tenantId: "ten_TEST123", userId: "usr_AGENT123", subject: "Colis", body: "Colis abîmé" }],
  ["create_ticket", "createTicket", { subject: "Colis", body: "Colis abîmé", orderId: "#1001" }, { tenantId: "ten_TEST123", userId: "usr_AGENT123", subject: "Colis", body: "Colis abîmé", orderId: "#1001" }],
  ["propose_refund", "proposeRefund", { orderId: "ord_TEST123", reason: "Produit abîmé" }, { tenantId: "ten_TEST123", actorId: "usr_AGENT123", orderId: "ord_TEST123", reason: "Produit abîmé" }],
] as const)("scopes %s to the authenticated tenant, ignoring identifiers from the model", async (tool, useCase, input, expected) => {
  const execute = vi.spyOn(useCases[useCase], "execute").mockResolvedValue({} as never);
  await (await tools())(tool, { ...input, ...injected });
  expect(execute).toHaveBeenCalledExactlyOnceWith(expected);
});

it.each(["approve_action", "reject_approval", "execute_refund", "get_approval", "resolve_ticket", "search_other_tenant"])(
  "exposes no %s tool to the model", async (tool) => {
    const spies = Object.values(useCases).map(useCase => vi.spyOn(useCase, "execute"));
    await expect((await tools())(tool, { approvalId: "apr_TEST123", ...injected })).rejects.toThrow("Unknown tool");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
