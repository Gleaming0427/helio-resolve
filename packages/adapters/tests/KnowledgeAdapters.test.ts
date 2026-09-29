import { afterEach, expect, it, vi } from "vitest";
import { TenantId } from "@helio/domain";

const mocks = vi.hoisted(() => ({
  s3: vi.fn(), sqs: vi.fn(), query: vi.fn(), bedrock: vi.fn(),
}));
vi.mock("../src/env.js", () => ({}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-s3")>(),
  S3Client: class { send = mocks.s3; },
}));
vi.mock("@aws-sdk/client-sqs", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-sqs")>(),
  SQSClient: class { send = mocks.sqs; },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-bedrock-runtime")>(),
  BedrockRuntimeClient: class { send = mocks.bedrock; },
}));
vi.mock("pg", () => ({ Pool: class { query = mocks.query; } }));

import { S3SqsKnowledgeIngestion } from "../src/ingestion.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("uploads an encrypted document and queues a string tenant identifier", async () => {
  vi.stubEnv("KNOWLEDGE_BUCKET", "test-bucket");
  vi.stubEnv("INGEST_QUEUE_URL", "https://sqs.example.test/queue");
  const tenantId = TenantId.of("ten_TEST123");
  const result = await new S3SqsKnowledgeIngestion().submit({ tenantId, title: "FAQ", text: "Help" });
  expect(mocks.s3.mock.calls[0]![0].input).toMatchObject({
    Bucket: "test-bucket", Key: result.documentKey, Body: "Help",
    ServerSideEncryption: "AES256", Metadata: { tenantid: tenantId.toString(), title: "FAQ" },
  });
  expect(JSON.parse(mocks.sqs.mock.calls[0]![0].input.MessageBody)).toEqual({
    tenantId: tenantId.toString(), bucket: "test-bucket", key: result.documentKey, title: "FAQ",
  });
});

it("passes chunk values in a single PostgreSQL parameter array", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/test");
  mocks.bedrock.mockResolvedValue({
    body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })),
  });
  const { ingestChunk } = await import("../src/knowledge.js");
  await ingestChunk({ tenantId: "ten_TEST123", chunkId: "chunk1", documentTitle: "FAQ", text: "Help" });
  expect(mocks.query).toHaveBeenCalledWith(
    expect.stringContaining("VALUES ($1, $2, $3, $4, $5::vector)"),
    ["chunk1", "ten_TEST123", "FAQ", "Help", "[0.1,0.2]"],
  );
});
