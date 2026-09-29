CREATE EXTENSION IF NOT EXISTS vector;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "Order" (
    "tenantId" VARCHAR(80) NOT NULL,
    "id" VARCHAR(80) NOT NULL,
    "status" VARCHAR(40) NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "paymentId" VARCHAR(80),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("tenantId", "id")
);

CREATE INDEX "Order_tenantId_status_idx" ON "Order"("tenantId", "status");

CREATE TABLE "Ticket" (
    "tenantId" VARCHAR(80) NOT NULL,
    "id" VARCHAR(80) NOT NULL,
    "createdBy" VARCHAR(80) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("tenantId", "id")
);

CREATE INDEX "Ticket_tenantId_status_idx" ON "Ticket"("tenantId", "status");

CREATE TABLE "Approval" (
    "tenantId" VARCHAR(80) NOT NULL,
    "id" VARCHAR(80) NOT NULL,
    "orderId" VARCHAR(80) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "approvedBy" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Approval_pkey" PRIMARY KEY ("tenantId", "id")
);

CREATE INDEX "Approval_tenantId_orderId_idx" ON "Approval"("tenantId", "orderId");

CREATE INDEX "Approval_tenantId_status_idx" ON "Approval"("tenantId", "status");

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid() :: text,
    "tenantId" VARCHAR(80) NOT NULL,
    "actorId" VARCHAR(80) NOT NULL,
    "action" VARCHAR(120) NOT NULL,
    "resourceType" VARCHAR(80) NOT NULL,
    "resourceId" VARCHAR(80),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

CREATE INDEX "AuditEvent_tenantId_action_idx" ON "AuditEvent"("tenantId", "action");

CREATE TABLE knowledge_chunk (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    document_title TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1024) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_chunk_tenant_idx ON knowledge_chunk(tenant_id);

CREATE INDEX knowledge_chunk_embedding_idx ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
