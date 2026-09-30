import { afterEach, expect, it, vi } from "vitest";
import { TenantId } from "@helio/domain";

const mocks = vi.hoisted(() => ({ query: vi.fn(), bedrock: vi.fn() }));
vi.mock("../src/env.js", () => ({}));
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-bedrock-runtime")>(),
  BedrockRuntimeClient: class { send = mocks.bedrock; },
}));
vi.mock("pg", () => ({ Pool: class { query = mocks.query; } }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("scopes semantic search to the requesting tenant and its published versions", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/test");
  mocks.bedrock.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })) });
  mocks.query.mockResolvedValue({ rows: [] });
  const { PgVectorKnowledgeSearch } = await import("../src/knowledge.js");
  await new PgVectorKnowledgeSearch().search({ tenantId: TenantId.of("ten_TEST123"), query: "FAQ", limit: 5 });
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE tenant_id = $2"), ["[0.1,0.2]", "ten_TEST123", 5]);
  expect(mocks.query.mock.calls[0]![0]).toContain(`d."publishedVersion" = knowledge_chunk.document_version`);
});
