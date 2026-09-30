ALTER TABLE "Membership" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "KnowledgeDocument" ADD COLUMN "publishedVersion" INTEGER,
 ADD COLUMN "lockedAt" TIMESTAMP(3), ADD COLUMN "failureCode" TEXT;
ALTER TABLE "KnowledgeDocumentVersion" ADD COLUMN "title" VARCHAR(300) NOT NULL DEFAULT '';
UPDATE "KnowledgeDocumentVersion" v SET title = d.title FROM "KnowledgeDocument" d
 WHERE v."tenantId"=d."tenantId" AND v."documentId"=d.id;
-- Existing uploads can be re-published by the administrator after migration.
UPDATE "KnowledgeDocument" SET status='draft';
ALTER TABLE knowledge_chunk ADD COLUMN document_id TEXT, ADD COLUMN document_version INTEGER;
CREATE INDEX knowledge_chunk_document_idx ON knowledge_chunk(tenant_id, document_id, document_version);
CREATE TABLE "SettingsRevision" (
 "tenantId" VARCHAR(80) NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
 locale TEXT NOT NULL, "responseTone" TEXT NOT NULL, "refundApprovalThresholdCents" INTEGER NOT NULL,
 "actorId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("tenantId",version));
INSERT INTO "SettingsRevision" ("tenantId",version,name,locale,"responseTone","refundApprovalThresholdCents","actorId")
 SELECT s."tenantId",s.version,t.name,s.locale,s."responseTone",s."refundApprovalThresholdCents",s."updatedBy"
 FROM "TenantSettings" s JOIN "Tenant" t ON t.id=s."tenantId";
CREATE TABLE "WorkspaceInvitation" (
 id TEXT PRIMARY KEY, "tenantId" VARCHAR(80) NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "acceptedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
 "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "WorkspaceInvitation_tenantId_idx" ON "WorkspaceInvitation"("tenantId");
