import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@helio/domain";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), jwks: vi.fn(), approve: vi.fn(), execute: vi.fn(), submit: vi.fn(), answer: vi.fn(), workspace: vi.fn(), member: vi.fn(), policy: vi.fn(), quota: vi.fn(),
  order: vi.fn(), approval: vi.fn(), ticket: vi.fn(), proposal: vi.fn(), invite: vi.fn(), revoke: vi.fn(), updateMember: vi.fn(),
  document: vi.fn(), publish: vi.fn(), withdraw: vi.fn(), accept: vi.fn(), updateEmail: vi.fn(), deleteDocument: vi.fn(),
  tickets: vi.fn(), resolveTicket: vi.fn(), approvals: vi.fn(), reject: vi.fn(), history: vi.fn(), append: vi.fn(),
  conversations: vi.fn(), conversation: vi.fn(), shopifyStatus: vi.fn(), shopifyConnect: vi.fn(), shopifyDisconnect: vi.fn(),
}));
vi.mock("../src/payments.js", () => ({
  shopifyConnections: { status: mocks.shopifyStatus, connect: mocks.shopifyConnect, disconnect: mocks.shopifyDisconnect },
}));
// Stands in for the shared PostgreSQL counter: one bucket per key for every app instance.
const counters = new Map<string, number>();
vi.mock("jose", () => ({ createRemoteJWKSet: mocks.jwks, jwtVerify: mocks.verify }));
vi.mock("@helio/adapters", () => ({
  rolesFor: (role: string) => role === "tenant_admin" ? ["tenant_admin", "support_manager"] : [role],
  quotaStore: { hit: mocks.quota },
  knownEmail: (email?: string) => email && !email.endsWith("@local.invalid") ? email : null,
  conversations: { history: mocks.history, append: mocks.append, list: mocks.conversations, get: mocks.conversation },
  workspaceRepository: {
    updateEmail: mocks.updateEmail,
    resolveMember: mocks.member,
    mayManageRefund: mocks.policy,
    saveDocument: mocks.submit,
    get: mocks.workspace,
    updateSettings: mocks.workspace,
    invite: mocks.invite,
    revokeInvitation: mocks.revoke,
    updateMember: mocks.updateMember,
    acceptInvitation: mocks.accept,
    document: mocks.document,
    publish: mocks.publish,
    withdraw: mocks.withdraw,
    deleteDocument: mocks.deleteDocument,
  },
}));
vi.mock("../src/container.js", () => ({
  useCases: {
    getOrder: { execute: mocks.order },
    getApproval: { execute: mocks.approval },
    createTicket: { execute: mocks.ticket },
    proposeRefund: { execute: mocks.proposal },
    approveAction: { execute: mocks.approve },
    executeRefund: { execute: mocks.execute },
    listTickets: { execute: mocks.tickets },
    resolveTicket: { execute: mocks.resolveTicket },
    listApprovals: { execute: mocks.approvals },
    rejectApproval: { execute: mocks.reject },
  },
  createAgent: () => ({ answer: mocks.answer }), tenantId: (value: string) => value,
}));
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.member.mockImplementation(async (userId, bootstrap) => ({ tenantId: bootstrap?.tenantId ?? "ten_TEST123", role: userId === "usr_AGENT123" ? "support_agent" : userId === "usr_MANAGER123" && !bootstrap ? "support_manager" : "tenant_admin" }));
  mocks.policy.mockResolvedValue(true);
  counters.clear();
  mocks.quota.mockImplementation(async (key: string) => {
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    return { count, retryAfterSeconds: 42 };
  });
  mocks.workspace.mockResolvedValue({ id: "ten_TEST123", name: "Test", slug: "ten-test123", settings: {}, memberships: [], documents: [] });
  vi.stubEnv("AUTH_MODE", "cognito");
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("COGNITO_USER_POOL_ID", "eu-west-3_test");
  vi.stubEnv("COGNITO_CLIENT_ID", "client-test");
  app = await buildApp();
});

function identity(tenant = "ten_TEST123", roles = ["support_manager", "tenant_admin"]) {
  return { payload: { sub: "MANAGER123", token_use: "access", client_id: "client-test",
    "cognito:groups": [`tenant__${tenant}`, ...roles] } };
}

it.each([
  { token_use: "id" }, { client_id: "another-client" },
  { "cognito:groups": ["tenant__ten_TEST123", "tenant__ten_OTHER123"] },
  { "cognito:groups": ["tenant__"] },
])("rejects invalid tenant or token claims: %j", async (override) => {
  mocks.verify.mockResolvedValue({ payload: { ...identity().payload, ...override } });
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve", headers: { authorization: "Bearer token" } });
  expect(response.statusCode).toBe(401);
  expect(mocks.approve).not.toHaveBeenCalled();
});

it("never trusts tenant or actor supplied by a client", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.approve.mockResolvedValue({ status: "approved" });
  await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve?tenantId=ten_OTHER123",
    headers: { authorization: "Bearer token", "x-tenant-id": "ten_OTHER123" },
    payload: { tenantId: "ten_OTHER123", managerUserId: "usr_OTHER123" } });
  expect(mocks.approve).toHaveBeenCalledWith({ tenantId: "ten_TEST123", managerUserId: "usr_MANAGER123", approvalId: "apr_TEST123" });
});

// Every tenant-scoped route, with another tenant and user injected everywhere a client can
// write them. The handler must reach its port with the caller's identity only.
const spoof = { tenantId: "ten_OTHER123", userId: "usr_OTHER123", actorId: "usr_OTHER123", managerUserId: "usr_OTHER123" };
const token = "a".repeat(64);
it.each([
  ["GET", "/orders/ord_TEST123", undefined, "order", "ten_TEST123"],
  ["POST", "/tickets", { subject: "Colis abîmé", body: "Le colis est arrivé abîmé." }, "ticket", "ten_TEST123"],
  ["POST", "/refund-proposals", { orderId: "ord_TEST123", reason: "Produit abîmé" }, "proposal", "ten_TEST123"],
  ["GET", "/approvals/apr_TEST123", undefined, "approval", "ten_TEST123"],
  ["POST", "/approvals/apr_TEST123/approve", undefined, "approve", "ten_TEST123"],
  ["POST", "/approvals/apr_TEST123/execute", undefined, "execute", "ten_TEST123"],
  ["POST", "/approvals/apr_TEST123/approve", undefined, "policy", "ten_TEST123"],
  ["GET", "/workspace", undefined, "workspace", "ten_TEST123"],
  ["PUT", "/workspace/settings", { expectedVersion: 1, name: "Acme", locale: "fr-FR", responseTone: "warm", refundApprovalThresholdCents: 0 }, "workspace", "ten_TEST123"],
  ["POST", "/workspace/invitations", { role: "support_agent" }, "invite", "ten_TEST123"],
  ["DELETE", "/workspace/invitations/inv_TEST123", undefined, "revoke", "ten_TEST123"],
  ["PATCH", "/workspace/members/usr_AGENT123", { role: "support_agent", active: false }, "updateMember", "ten_TEST123"],
  ["GET", "/knowledge/documents", undefined, "workspace", "ten_TEST123"],
  ["GET", "/knowledge/documents/doc_TEST123", undefined, "document", "ten_TEST123"],
  ["POST", "/knowledge/documents", { title: "Livraison", text: "La livraison express prend 48 heures." }, "submit", "ten_TEST123"],
  ["PUT", "/knowledge/documents/doc_TEST123", { title: "Livraison", text: "La livraison express prend 48 heures.", expectedVersion: 1 }, "submit", "ten_TEST123"],
  ["POST", "/knowledge/documents/doc_TEST123/publish", { version: 1 }, "publish", "ten_TEST123"],
  ["POST", "/knowledge/documents/doc_TEST123/withdraw", undefined, "withdraw", "ten_TEST123"],
  ["DELETE", "/knowledge/documents/doc_TEST123", undefined, "deleteDocument", "ten_TEST123"],
  ["POST", "/chat", { message: "Où en est ma commande ?" }, "answer", "ten_TEST123"],
  ["POST", "/chat", { message: "Et ensuite ?", conversationId: "11111111-2222-4333-8444-555555555555" }, "history", "ten_TEST123"],
  ["POST", "/chat", { message: "Et ensuite ?" }, "append", "ten_TEST123"],
  ["GET", "/conversations", undefined, "conversations", "usr_MANAGER123"],
  ["GET", "/conversations/11111111-2222-4333-8444-555555555555", undefined, "conversation", "usr_MANAGER123"],
  ["GET", "/tickets", undefined, "tickets", "ten_TEST123"],
  ["POST", "/tickets/tkt_TEST123/resolve", undefined, "resolveTicket", "usr_MANAGER123"],
  ["GET", "/approvals", undefined, "approvals", "ten_TEST123"],
  ["POST", "/approvals/apr_TEST123/reject", undefined, "reject", "usr_MANAGER123"],
  ["GET", "/workspace/shopify", undefined, "shopifyStatus", "ten_TEST123"],
  ["PUT", "/workspace/shopify", { shopDomain: "helio-test.myshopify.com", accessToken: `shpat_${"a".repeat(32)}` }, "shopifyConnect", "ten_TEST123"],
  ["DELETE", "/workspace/shopify", undefined, "shopifyDisconnect", "usr_MANAGER123"],
  // The invitation decides the tenant; the caller only brings their own identity.
  ["POST", "/invitations/accept", { token }, "accept", "usr_MANAGER123"],
] as const)("%s %s acts only for the caller's tenant and identity", async (method, url, payload, target, expected) => {
  mocks.verify.mockResolvedValue(identity());
  if (target !== "workspace") mocks[target].mockResolvedValue({ ok: true });
  const response = await app.inject({ method, url: `${url}?tenantId=ten_OTHER123&userId=usr_OTHER123`,
    headers: { authorization: "Bearer token", "x-tenant-id": "ten_OTHER123", "x-user-id": "usr_OTHER123" },
    ...(payload ? { payload: { ...spoof, ...payload } } : {}) });
  expect(response.statusCode).toBeLessThan(300);
  expect(JSON.stringify(mocks[target].mock.calls)).toContain(expected);
  expect(JSON.stringify(Object.values(mocks).map(mock => mock.mock.calls))).not.toMatch(/ten_OTHER123|usr_OTHER123/);
});

it("answers with the conversation's history and stores the new turn", async () => {
  mocks.verify.mockResolvedValue(identity());
  const conversationId = "11111111-2222-4333-8444-555555555555";
  const history = [{ role: "user", text: "Où en est #1001 ?" }, { role: "assistant", text: "Expédiée." }];
  const reply = { text: "Oui.", citations: [], actions: [{ type: "refund_proposed", approvalId: "apr_TEST123" }] };
  mocks.history.mockResolvedValue(history);
  mocks.answer.mockResolvedValue(reply);
  mocks.append.mockResolvedValue(conversationId);
  const response = await app.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer token" }, payload: { message: "Et payée ?", conversationId } });
  expect(response.json()).toEqual({ ...reply, conversationId });
  expect(mocks.history).toHaveBeenCalledWith("ten_TEST123", "usr_MANAGER123", conversationId);
  expect(mocks.answer).toHaveBeenCalledWith({ tenantId: "ten_TEST123", userId: "usr_MANAGER123", message: "Et payée ?", history });
  expect(mocks.append).toHaveBeenCalledWith({ tenantId: "ten_TEST123", userId: "usr_MANAGER123", conversationId, message: "Et payée ?", reply });
});

it("does not call the model for someone else's conversation", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.history.mockRejectedValue(new DomainError("Conversation introuvable."));
  const response = await app.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer token" },
    payload: { message: "Et ensuite ?", conversationId: "11111111-2222-4333-8444-555555555555" } });
  expect(response.statusCode).toBe(409);
  expect(mocks.answer).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
});

it.each([
  ["another host", "evil.example.com"],
  ["an internal address", "169.254.169.254"],
  ["a URL", "https://helio-test.myshopify.com/admin"],
  ["a look-alike domain", "helio-test.myshopify.com.evil.io"],
])("refuses to connect Shopify through %s", async (_case, shopDomain) => {
  mocks.verify.mockResolvedValue(identity());
  const response = await app.inject({ method: "PUT", url: "/workspace/shopify", headers: { authorization: "Bearer token" },
    payload: { shopDomain, accessToken: `shpat_${"a".repeat(32)}` } });
  expect(response.statusCode).toBe(400);
  expect(mocks.shopifyConnect).not.toHaveBeenCalled();
});

it("never echoes the Shopify access token", async () => {
  const logs = await withCapturedLogs();
  mocks.verify.mockResolvedValue(identity());
  const token = `shpat_${"b".repeat(32)}`;
  mocks.shopifyConnect.mockResolvedValue({ shopDomain: "helio-test.myshopify.com", shopName: "Helio Test" });
  const ok = await app.inject({ method: "PUT", url: "/workspace/shopify", headers: { authorization: "Bearer token" }, payload: { shopDomain: "Helio-Test.myshopify.com", accessToken: token } });
  const invalid = await app.inject({ method: "PUT", url: "/workspace/shopify", headers: { authorization: "Bearer token" }, payload: { shopDomain: "evil.io", accessToken: token } });
  expect(ok.json()).toEqual({ shopDomain: "helio-test.myshopify.com", shopName: "Helio Test" });
  expect(mocks.shopifyConnect).toHaveBeenCalledWith({ tenantId: "ten_TEST123", actorId: "usr_MANAGER123", shopDomain: "helio-test.myshopify.com", accessToken: token });
  expect(ok.body + invalid.body + JSON.stringify(logs())).not.toContain("bbbbbbbb");
});

it("keeps store connection and refund decisions to the right roles", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.member.mockResolvedValue({ tenantId: "ten_TEST123", role: "support_agent" });
  for (const [method, url] of [["GET", "/workspace/shopify"], ["DELETE", "/workspace/shopify"], ["GET", "/approvals"], ["POST", "/approvals/apr_TEST123/reject"]] as const) {
    expect((await app.inject({ method, url, headers: { authorization: "Bearer token" } })).statusCode).toBe(403);
  }
  mocks.tickets.mockResolvedValue([]);
  expect((await app.inject({ method: "GET", url: "/tickets", headers: { authorization: "Bearer token" } })).statusCode).toBe(200);
  expect(mocks.shopifyDisconnect).not.toHaveBeenCalled();
  expect(mocks.reject).not.toHaveBeenCalled();
});

it("lets a local demo act as another member, but only in development mode", async () => {
  vi.stubEnv("AUTH_MODE", "dev"); vi.stubEnv("NODE_ENV", "development");
  mocks.member.mockImplementation(async (userId: string) => ({ tenantId: "ten_DEMO123", role: userId === "usr_DEMOAGENT" ? "support_agent" : "tenant_admin" }));
  const me = (header?: string) => app.inject({ method: "GET", url: "/me", headers: header ? { "x-dev-user": header } : {} }).then(response => response.json());
  expect(await me("usr_DEMOAGENT")).toMatchObject({ userId: "usr_DEMOAGENT", roles: ["support_agent"] });
  expect(await me("not-a-user")).toMatchObject({ userId: "usr_DEMO123" });
  expect(await me()).toMatchObject({ userId: "usr_DEMO123" });
  vi.stubEnv("NODE_ENV", "production");
  const production = await app.inject({ method: "GET", url: "/me", headers: { "x-dev-user": "usr_DEMOAGENT" } });
  expect(production.statusCode).toBe(401);
});

it("does not enable development identity in production", async () => {
  vi.stubEnv("AUTH_MODE", "dev"); vi.stubEnv("NODE_ENV", "production");
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve" });
  expect(response.statusCode).toBe(401);
  expect(mocks.approve).not.toHaveBeenCalled();
});

it("limits chat per tenant and leaves another tenant's allowance intact", async () => {
  mocks.verify.mockImplementation(async (token) => identity(token === "B" ? "ten_OTHER123" : "ten_TEST123"));
  mocks.answer.mockResolvedValue({ text: "OK", citations: [] });
  for (let i = 0; i < 20; i++) {
    const response = await app.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer A" }, payload: { message: "Bonjour" } });
    expect(response.statusCode).toBe(200);
  }
  const blocked = await app.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer A" }, payload: { message: "Bonjour" } });
  expect(blocked.statusCode).toBe(429);
  expect(blocked.json()).toEqual({ error: "quota_exceeded" });
  expect(blocked.headers["retry-after"]).toBe("42");
  const other = await app.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer B" }, payload: { message: "Bonjour" } });
  expect(other.statusCode).toBe(200);
  expect(mocks.answer).toHaveBeenCalledTimes(21);
  expect(mocks.quota).toHaveBeenCalledWith("chat:ten_TEST123", 60);
  expect(mocks.quota).toHaveBeenCalledWith("chat:ten_OTHER123", 60);
});

it("keeps the tenant quota when requests are spread across API instances", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.answer.mockResolvedValue({ text: "OK", citations: [] });
  const second = await buildApp();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const instance = i % 2 ? second : app;
      statuses.push((await instance.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer A" }, payload: { message: "Bonjour" } })).statusCode);
    }
    expect(statuses.filter(status => status === 200)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  } finally { await second.close(); }
});

it("limits the client address forwarded by the load balancer, not the load balancer itself", async () => {
  await app.close();
  vi.stubEnv("TRUST_PROXY_HOPS", "1");
  app = await buildApp();
  // A client can prepend any address; only the one appended by the ALB counts.
  const from = (client: string, spoofed = "198.51.100.1") => app.inject({ method: "GET", url: "/health",
    remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": `${spoofed}, ${client}` } });
  for (let i = 0; i < 120; i++) expect((await from("203.0.113.1", `198.51.100.${i}`)).statusCode).toBe(200);
  expect((await from("203.0.113.1", "198.51.100.250")).statusCode).toBe(429);
  expect((await from("203.0.113.2")).statusCode).toBe(200);
});

it("refuses an invalid proxy hop count", async () => {
  vi.stubEnv("TRUST_PROXY_HOPS", "true");
  await expect(buildApp()).rejects.toThrow("TRUST_PROXY_HOPS");
});

it("returns a reference without exposing internal errors", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.approve.mockRejectedValue(new Error("postgresql://user:secret@example/private"));
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve", headers: { authorization: "Bearer token" } });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: "internal_error", requestId: expect.any(String) });
  expect(response.body).not.toContain("secret");
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });

async function withCapturedLogs() {
  await app.close();
  const lines: string[] = [];
  app = await buildApp({ logStream: { write: line => { lines.push(line); } } });
  return () => lines.map(line => JSON.parse(line) as Record<string, unknown>);
}

it("logs the cause of an internal error under the reference given to the client, without credentials", async () => {
  const logs = await withCapturedLogs();
  mocks.verify.mockResolvedValue(identity());
  mocks.approve.mockRejectedValue(Object.assign(new Error("connect failed postgresql://helio:s3cret@db:5432/helio (Bearer abc.def.ghi)"), { code: "P1001" }));
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve", headers: { authorization: "Bearer token" } });
  const { requestId } = response.json();
  expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(response.headers["x-request-id"]).toBe(requestId);
  expect(logs().find(entry => entry.msg === "Request failed")).toMatchObject({
    level: 50, reqId: requestId,
    error: { type: "Error", code: "P1001", message: "connect failed postgresql://***@db:5432/helio (Bearer ***)", stack: expect.stringContaining("postgresql://***@db") },
  });
  expect(JSON.stringify(logs())).not.toMatch(/s3cret|abc\.def/);
});

it("logs rejected client requests as information, not as incidents", async () => {
  const logs = await withCapturedLogs();
  mocks.verify.mockResolvedValue(identity());
  mocks.approve.mockRejectedValue(new DomainError("Approval not found"));
  const conflict = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve", headers: { authorization: "Bearer token" } });
  const invalid = await app.inject({ method: "PUT", url: "/workspace/settings", headers: { authorization: "Bearer token" }, payload: {} });
  expect([conflict.statusCode, invalid.statusCode]).toEqual([409, 400]);
  expect(logs().filter(entry => entry.msg === "Request rejected")).toMatchObject([
    { level: 30, statusCode: 409, errorType: "DomainError" }, { level: 30, statusCode: 400, errorType: "ZodError" },
  ]);
  expect(logs().some(entry => (entry.level as number) >= 50)).toBe(false);
});

it("gives every response a distinct reference, including across instances", async () => {
  const second = await buildApp();
  try {
    const ids = [];
    for (const instance of [app, app, second, second]) ids.push((await instance.inject({ method: "GET", url: "/health" })).headers["x-request-id"]);
    expect(new Set(ids).size).toBe(4);
  } finally { await second.close(); }
});

it("reuses one Cognito key set per issuer instead of fetching it on every request", async () => {
  // A pool ID of its own: the key set cache lives for the process lifetime.
  vi.stubEnv("COGNITO_USER_POOL_ID", "eu-west-3_cache");
  mocks.jwks.mockImplementation((url: URL) => ({ url: url.href }));
  mocks.verify.mockResolvedValue(identity());
  for (let i = 0; i < 3; i++) {
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer valid" } })).statusCode).toBe(200);
  }
  expect(mocks.jwks).toHaveBeenCalledTimes(1);
  expect(mocks.jwks).toHaveBeenCalledWith(new URL("https://cognito-idp.eu-west-3.amazonaws.com/eu-west-3_cache/.well-known/jwks.json"));
  const keySets = mocks.verify.mock.calls.map(call => call[1]);
  expect(new Set(keySets).size).toBe(1);
  expect(mocks.verify).toHaveBeenLastCalledWith("valid", keySets[0], { issuer: "https://cognito-idp.eu-west-3.amazonaws.com/eu-west-3_cache" });
});

it("rejects a request without a token", async () => {
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve" });
  expect(response.statusCode).toBe(401);
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("preserves a bad-request status for an empty JSON body", async () => {
  const response = await app.inject({
    method: "POST", url: "/approvals/apr_TEST123/approve",
    headers: { "content-type": "application/json" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "invalid_request" });
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("verifies the token and rejects a failed signature", async () => {
  mocks.verify.mockRejectedValue(new Error("Invalid signature"));
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve", headers: { authorization: "Bearer invalid" } });
  expect(mocks.verify).toHaveBeenCalled();
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: "invalid_token" });
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("allows a verified manager to approve and execute an action", async () => {
  mocks.verify.mockResolvedValue({ payload: {
    sub: "MANAGER123", token_use: "access", client_id: "client-test",
    "cognito:groups": ["tenant__ten_TEST123", "support_manager"],
  } });
  mocks.approve.mockResolvedValue({ status: "approved" });
  mocks.execute.mockResolvedValue({ status: "refunded" });
  for (const action of ["approve", "execute"]) {
    const response = await app.inject({ method: "POST", url: `/approvals/apr_TEST123/${action}`, headers: { authorization: "Bearer valid" } });
    expect(response.statusCode).toBe(200);
  }
  const input = { tenantId: "ten_TEST123", approvalId: "apr_TEST123", managerUserId: "usr_MANAGER123" };
  expect(mocks.approve).toHaveBeenCalledWith(input);
  expect(mocks.execute).toHaveBeenCalledWith(input);
});
it("denies manager actions to users without the required role", async () => {
  mocks.verify.mockResolvedValue({ payload: {
    sub: "AGENT123", token_use: "access", client_id: "client-test",
    "cognito:groups": ["tenant__ten_TEST123"],
  } });
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve", headers: { authorization: "Bearer valid" } });
  expect(response.statusCode).toBe(403);
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("routes document uploads to the authenticated tenant", async () => {
  mocks.verify.mockResolvedValue({ payload: {
    sub: "ADMIN123", token_use: "access", client_id: "client-test",
    "cognito:groups": ["tenant__ten_TEST123", "tenant_admin"],
  } });
  mocks.submit.mockResolvedValue({ status: "queued", documentKey: "ten_TEST123/12345678-1234-1234-1234-123456789012.txt" });
  const response = await app.inject({ method: "POST", url: "/knowledge/documents", headers: { authorization: "Bearer valid" }, payload: { title: "FAQ", text: "A sufficiently long support document." } });
  expect(response.statusCode).toBe(201);
  expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_TEST123", actorId: "usr_ADMIN123" }));
});

it("uses stored membership instead of obsolete administrator groups", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.member.mockResolvedValue({ tenantId: "ten_TEST123", role: "support_agent" });
  for (const [method, url] of [["GET", "/workspace"], ["GET", "/knowledge/documents"], ["DELETE", "/knowledge/documents/doc_TEST123"]] as const) {
    const response = await app.inject({ method, url, headers: { authorization: "Bearer valid" } });
    expect(response.statusCode).toBe(403);
  }
  expect(mocks.deleteDocument).not.toHaveBeenCalled();
  mocks.member.mockResolvedValue(null);
  const response = await app.inject({ method: "POST", url: "/chat", headers: { authorization: "Bearer valid" }, payload: { message: "Bonjour" } });
  expect(response.statusCode).toBe(403);
  expect(mocks.answer).not.toHaveBeenCalled();
});

it("allows an invited member without Cognito tenant groups", async () => {
  mocks.verify.mockResolvedValue({ payload: { ...identity().payload, "cognito:groups": [] } });
  mocks.member.mockResolvedValue({ tenantId: "ten_TEST123", role: "support_agent" });
  const response = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer valid" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ userId: "usr_MANAGER123", tenantId: "ten_TEST123", roles: ["support_agent"], email: null });
});

// Cognito subjects are UUIDs; the user ID keeps their first 16 hex digits.
const subject = "0123abcd-4567-89ef-0123-456789abcdef";
const userId = "usr_0123abcd456789ef";
function tokens(idPayload: Record<string, unknown>) {
  mocks.verify.mockImplementation(async (token: string) => token === "access"
    ? { payload: { sub: subject, token_use: "access", client_id: "client-test", "cognito:groups": [] } }
    : { payload: { sub: subject, token_use: "id", aud: "client-test", email: "Alice.Martin@Example.com", email_verified: true, ...idPayload } });
  mocks.member.mockResolvedValue({ tenantId: "ten_TEST123", role: "support_agent", email: `${userId}@local.invalid` });
}
const syncEmail = (body: unknown = { idToken: "id" }) => app.inject({ method: "PUT", url: "/me/email", headers: { authorization: "Bearer access" }, payload: body });

it("records the email verified by Cognito for the caller", async () => {
  tokens({});
  const response = await syncEmail({ idToken: "id", email: "attacker@example.com", userId: "usr_OTHER123" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ email: "alice.martin@example.com" });
  expect(mocks.updateEmail).toHaveBeenCalledExactlyOnceWith(userId, "alice.martin@example.com");
  // The ID token must be issued for this app client by the same user pool.
  const [token, , options] = mocks.verify.mock.calls.at(-1)!;
  expect(token).toBe("id");
  expect(options).toEqual({ issuer: "https://cognito-idp.eu-west-3.amazonaws.com/eu-west-3_test", audience: "client-test" });
});

it.each([
  ["an access token instead of an ID token", { token_use: "access" }],
  ["another user's ID token", { sub: "ffffffff-4567-89ef-0123-456789abcdef" }],
  ["an unverified email", { email_verified: false }],
  ["a token without email", { email: undefined }],
  ["a malformed email", { email: "not-an-email" }],
])("refuses %s", async (_case, idPayload) => {
  tokens(idPayload);
  const response = await syncEmail();
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "invalid_id_token" });
  expect(mocks.updateEmail).not.toHaveBeenCalled();
});

it("refuses an ID token with an invalid signature", async () => {
  tokens({});
  mocks.verify.mockImplementation(async (token: string) => {
    if (token === "access") return { payload: { sub: subject, token_use: "access", client_id: "client-test", "cognito:groups": [] } };
    throw new Error("signature verification failed");
  });
  expect((await syncEmail()).statusCode).toBe(400);
  expect(mocks.updateEmail).not.toHaveBeenCalled();
});

it("shows administrators verified emails only", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.workspace.mockResolvedValue({ id: "ten_TEST123", name: "Test", settings: {}, documents: [], revisions: [], invitations: [], memberships: [
    { userId: "usr_ALICE123", email: "alice@example.com", role: "tenant_admin", active: true },
    { userId: "usr_BOB12345", email: "usr_BOB12345@local.invalid", role: "support_agent", active: true },
  ] });
  const response = await app.inject({ method: "GET", url: "/workspace", headers: { authorization: "Bearer valid" } });
  expect(response.json().members.map((member: { email: string | null }) => member.email)).toEqual(["alice@example.com", null]);
});

it("blocks manager refunds above the configured ceiling", async () => {
  mocks.verify.mockResolvedValue(identity());
  mocks.member.mockResolvedValue({ tenantId: "ten_TEST123", role: "support_manager" });
  mocks.policy.mockResolvedValue(false);
  for (const action of ["approve", "execute"]) {
    const response = await app.inject({ method: "POST", url: `/approvals/apr_TEST123/${action}`, headers: { authorization: "Bearer valid" } });
    expect(response.statusCode).toBe(403);
  }
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("scopes versioned settings to the authenticated administrator", async () => {
  mocks.verify.mockResolvedValue(identity());
  const response = await app.inject({ method: "PUT", url: "/workspace/settings", headers: { authorization: "Bearer valid" }, payload: {
    tenantId: "ten_ATTACK", actorId: "usr_ATTACK", expectedVersion: 1, name: "Acme", locale: "fr-FR", responseTone: "warm", refundApprovalThresholdCents: 9950,
  } });
  expect(response.statusCode).toBe(200);
  expect(mocks.workspace).toHaveBeenCalledWith({ tenantId: "ten_TEST123", actorId: "usr_MANAGER123", expectedVersion: 1, name: "Acme", locale: "fr-FR", responseTone: "warm", refundApprovalThresholdCents: 9950 });
});

it("allows browser preflights for settings, member edits and invitation revocation", async () => {
  await app.close();
  vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  app = await buildApp();
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await app.inject({ method: "OPTIONS", url: "/workspace/settings", headers: { origin: "http://localhost:5173", "access-control-request-method": method } });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain(method);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  }
  const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:5173" } });
  expect(response.headers["access-control-expose-headers"]).toContain("x-request-id");
});
