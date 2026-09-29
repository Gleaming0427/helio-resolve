import "./env.js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { KnowledgeIngestion } from "@helio/application";

export class S3SqsKnowledgeIngestion implements KnowledgeIngestion {
  private readonly s3 = new S3Client({});
  private readonly sqs = new SQSClient({});

  async submit(
    input: Parameters<KnowledgeIngestion["submit"]>[0],
  ): Promise<{ documentKey: string }> {
    const bucket = process.env.KNOWLEDGE_BUCKET;
    const queueUrl = process.env.INGEST_QUEUE_URL;
    if (!bucket || !queueUrl) {
      throw new Error("KNOWLEDGE_BUCKET and INGEST_QUEUE_URL are required");
    }

    const tenantId = input.tenantId.toString();
    const documentId = crypto.randomUUID();
    const key = `${tenantId}/${documentId}.txt`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: input.text,
        ContentType: "text/plain; charset=utf-8",
        Metadata: {
          tenantid: tenantId,
          title: input.title.slice(0, 500),
        },
        ServerSideEncryption: "AES256",
      }),
    );
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ tenantId, bucket, key, title: input.title }),
      }),
    );
    return { documentKey: key };
  }
}
