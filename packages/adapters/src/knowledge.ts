import { databaseUrl } from "./database-config.js";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { KnowledgeHit, KnowledgeSearch } from "@helio/application";
import { Pool } from "pg";
const bedrock = new BedrockRuntimeClient({});
const pool = new Pool({ connectionString: databaseUrl() });
export async function embed(text: string): Promise<number[]> {
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
  constructor(private readonly embedding = embed, private readonly database = pool) {}
  async search(
    input: Parameters<KnowledgeSearch["search"]>[0],
  ): Promise<KnowledgeHit[]> {
    const embedding = await this.embedding(input.query);
    const vectorLiteral = `[${embedding.join(",")}]`;
    const result = await this.database.query<{
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
AND EXISTS (SELECT 1 FROM "KnowledgeDocument" d WHERE d."tenantId" = knowledge_chunk.tenant_id
 AND d.id = knowledge_chunk.document_id AND d."publishedVersion" = knowledge_chunk.document_version)
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
