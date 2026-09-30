import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";
import { embed } from "./knowledge.js";
import { jsonLog, loggableError, type Log } from "./log.js";

// PostgreSQL is the durable queue for managed documents. No S3/SQS dual write.
export async function processNextDocument(db: PrismaClient = prisma, embedding = embed, log: Log = jsonLog): Promise<boolean> {
  const lease = new Date();
  const jobs = await db.$queryRaw<{tenantId:string;id:string;currentVersion:number}[]>`
    UPDATE "KnowledgeDocument" SET status='processing', "lockedAt"=${lease}, "failureCode"=NULL
    WHERE ("tenantId",id) IN (
      SELECT "tenantId",id FROM "KnowledgeDocument"
      WHERE status='queued' OR (status='processing' AND "lockedAt" < ${new Date(Date.now()-300000)})
      ORDER BY "updatedAt" LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING "tenantId",id,"currentVersion"`;
  const job = jobs[0];
  if (!job) return false;
  const scope = { tenantId:job.tenantId,id:job.id,currentVersion:job.currentVersion,status:"processing",lockedAt:lease };
  const context = { tenantId:job.tenantId,documentId:job.id,version:job.currentVersion };
  // The failure code tells the administrator what to do: wait for Bedrock, or report it.
  let failureCode = "storage_failed";
  try {
    const version = await db.knowledgeDocumentVersion.findUniqueOrThrow({ where: { tenantId_documentId_version: { tenantId:job.tenantId,documentId:job.id,version:job.currentVersion } } });
    failureCode = "embedding_failed";
    const chunks: {text:string;vector:string}[]=[];
    for (let start=0; start<version.content.length; start+=1050) {
      const text=version.content.slice(start,start+1200);
      chunks.push({text,vector:`[${(await embedding(text)).join(",")}]`});
    }
    failureCode = "storage_failed";
    const published = await db.$transaction(async tx => {
      // CAS locks the document; a withdrawn/edited job cannot publish stale data.
      const changed=await tx.knowledgeDocument.updateMany({where:scope,data:{status:"published",publishedVersion:job.currentVersion,lockedAt:null}});
      if (!changed.count) return false;
      await tx.$executeRaw`DELETE FROM knowledge_chunk WHERE tenant_id=${job.tenantId} AND document_id=${job.id}`;
      for (const chunk of chunks) {
        await tx.$executeRaw`INSERT INTO knowledge_chunk(id,tenant_id,document_title,content,embedding,document_id,document_version)
          VALUES(${randomUUID()},${job.tenantId},${version.title},${chunk.text},${chunk.vector}::vector,${job.id},${job.currentVersion})`;
      }
      return true;
    }, {timeout:30000});
    log(published
      ? { level:"info", event:"document_indexed", ...context, chunks:chunks.length, durationMs:Date.now()-lease.getTime() }
      : { level:"info", event:"document_indexing_superseded", ...context });
  } catch (error) {
    log({ level:"error", event:"document_indexing_failed", ...context, failureCode, error:loggableError(error) });
    await db.knowledgeDocument.updateMany({where:scope,data:{status:"failed",failureCode,lockedAt:null}});
  }
  return true;
}
