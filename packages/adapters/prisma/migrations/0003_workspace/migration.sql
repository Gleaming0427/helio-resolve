CREATE TABLE "Tenant" (
    "id" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

CREATE TABLE "TenantSettings" (
    "tenantId" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "locale" VARCHAR(20) NOT NULL DEFAULT 'fr-FR',
    "responseTone" VARCHAR(40) NOT NULL DEFAULT 'professional',
    "refundApprovalThresholdCents" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" VARCHAR(80) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Membership" (
    "tenantId" VARCHAR(80) NOT NULL,
    "userId" VARCHAR(80) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("tenantId", "userId"),
    CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Membership_tenantId_role_idx" ON "Membership"("tenantId", "role");

CREATE TABLE "KnowledgeDocument" (
    "tenantId" VARCHAR(80) NOT NULL,
    "id" VARCHAR(80) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "sourceKey" VARCHAR(500) NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdBy" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("tenantId", "id"),
    CONSTRAINT "KnowledgeDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "KnowledgeDocument_tenantId_status_idx" ON "KnowledgeDocument"("tenantId", "status");

CREATE TABLE "KnowledgeDocumentVersion" (
    "tenantId" VARCHAR(80) NOT NULL,
    "documentId" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdBy" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeDocumentVersion_pkey" PRIMARY KEY ("tenantId", "documentId", "version"),
    CONSTRAINT "KnowledgeDocumentVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KnowledgeDocumentVersion_document_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "KnowledgeDocument"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
