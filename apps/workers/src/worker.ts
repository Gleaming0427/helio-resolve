import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ingestChunk } from "@helio/adapters";
import { z } from "zod";
const queueUrl = process.env.INGEST_QUEUE_URL;
if (!queueUrl) {
  throw new Error("INGEST_QUEUE_URL is required");
}
const sqs = new SQSClient({});
const s3 = new S3Client({});
const IngestionMessage = z.object({
  tenantId: z.string(),
  bucket: z.string(),
  key: z.string(),
  title: z.string(),
});
function splitIntoChunks(text: string, size = 1_200, overlap = 150): string[] {
  const chunks: string[] = [];
  const step = size - overlap;
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
  }
  return chunks;
}
async function processMessage(body: string): Promise<void> {
  const message = IngestionMessage.parse(JSON.parse(body));
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: message.bucket,
      Key: message.key,
    }),
  );
  if (!object.Body) {
    throw new Error("S3 object has no body");
  }
  const text = await object.Body.transformToString();
  const chunks = splitIntoChunks(text);
  for (const [index, chunk] of chunks.entries()) {
    const safeKey = message.key.replace(/[^a-zA-Z0-9]/g, "_");
    await ingestChunk({
      tenantId: message.tenantId,
      documentTitle: message.title,
      chunkId: `${message.tenantId}_${safeKey}_${index}`,
      text: chunk,
    });
  }
}
for (;;) {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      WaitTimeSeconds: 20,
      MaxNumberOfMessages: 5,
    }),
  );
  for (const message of response.Messages ?? []) {
    try {
      await processMessage(message.Body ?? "{}");
      if (message.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    } catch (error) {
      console.error("Knowledge ingestion failed", error);
      // The message remains in SQS and will be retried after visibility timeout.
      // In production, attach a DLQ with a bounded maxReceiveCount.
    }
  }
}
