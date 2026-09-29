import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), approve: vi.fn(), execute: vi.fn(), submit: vi.fn(),
}));
vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: mocks.verify }));
vi.mock("../src/container.js", () => ({
  useCases: {
    approveAction: { execute: mocks.approve },
    executeRefund: { execute: mocks.execute },
    submitKnowledge: { execute: mocks.submit },
  },
  createAgent: vi.fn(), tenantId: vi.fn(),
}));
import { buildApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("AUTH_MODE", "cognito");
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("COGNITO_USER_POOL_ID", "eu-west-3_test");
  vi.stubEnv("COGNITO_CLIENT_ID", "client-test");
  app = await buildApp();
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });

it("rejects a request without a token", async () => {
  const response = await app.inject({ method: "POST", url: "/approvals/apr_TEST123/approve" });
  expect(response.statusCode).toBe(401);
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
  mocks.submit.mockResolvedValue({ status: "queued" });
  const response = await app.inject({ method: "POST", url: "/knowledge/documents", headers: { authorization: "Bearer valid" }, payload: { title: "FAQ", text: "A sufficiently long support document." } });
  expect(response.statusCode).toBe(202);
  expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_TEST123", actorId: "usr_ADMIN123" }));
});
