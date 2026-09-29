import { databaseUrl } from "./database-config.js";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { KnowledgeHit, KnowledgeSearch } from "@helio/application";
import { Pool } from "pg";
const bedrock = new BedrockRuntimeClient({});
const pool = new Pool({ connectionString: databaseUrl() });
async function embed(text: string): Promise<number[]> {
  const body = JSON.stringify({
    inputText: text,
    dimensions: 1024,
    normalize: true,
  });
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId:
        process.env.BEDROCK_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(body),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding: number[];
  };
  return parsed.embedding;
}
export class PgVectorKnowledgeSearch implements KnowledgeSearch {
  async search(
    input: Parameters<KnowledgeSearch["search"]>[0],
  ): Promise<KnowledgeHit[]> {
    const embedding = await embed(input.query);
    const vectorLiteral = `[${embedding.join(",")}]`;
    const result = await pool.query<{
      id: string;
      document_title: string;
      content: string;
      score: number;
    }>(
      `
SELECT
id,
document_title,
content,
1 - (embedding <=> $1::vector) AS score
FROM knowledge_chunk
WHERE tenant_id = $2
ORDER BY embedding <=> $1::vector
LIMIT $3
`,
      [vectorLiteral, input.tenantId.toString(), input.limit],
    );
    return result.rows.map((row) => ({
      chunkId: row.id,
      documentTitle: row.document_title,
      text: row.content,
      score: Number(row.score),
    }));
  }
}
export async function ingestChunk(input: {
  tenantId: string;
  documentTitle: string;
  chunkId: string;
  text: string;
}): Promise<void> {
  const embedding = await embed(input.text);
  const vectorLiteral = `[${embedding.join(",")}]`;
  await pool.query(
    `
INSERT INTO knowledge_chunk (
id,
tenant_id,
document_title,
content,
embedding
)
VALUES ($1, $2, $3, $4, $5::vector)
ON CONFLICT (id)
DO UPDATE SET
document_title = EXCLUDED.document_title,
content = EXCLUDED.content,
embedding = EXCLUDED.embedding
`,
    [input.chunkId, input.tenantId, input.documentTitle, input.text, vectorLiteral],
  );
}
