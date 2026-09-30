-- Orders synced from Shopify keep the number the customer sees.
ALTER TABLE "Order" ADD COLUMN "reference" VARCHAR(40);

-- Tickets: link to an order and record who resolved them.
ALTER TABLE "Ticket" ADD COLUMN "orderId" VARCHAR(80), ADD COLUMN "resolvedBy" VARCHAR(80), ADD COLUMN "resolvedAt" TIMESTAMP(3);
CREATE INDEX "Ticket_tenantId_createdAt_idx" ON "Ticket"("tenantId", "createdAt");

-- Four-eyes control needs the author of each proposal; recover it from the audit trail.
ALTER TABLE "Approval" ADD COLUMN "proposedBy" VARCHAR(80);
UPDATE "Approval" a SET "proposedBy" = e."actorId" FROM "AuditEvent" e
 WHERE e."tenantId" = a."tenantId" AND e.action = 'refund.proposed' AND e."resourceId" = a.id;

-- Existing intents ran against the simulated provider, for the full order amount.
ALTER TABLE "RefundExecution" ADD COLUMN "account" VARCHAR(200), ADD COLUMN "amountCents" INTEGER,
 ADD COLUMN "currency" VARCHAR(3), ADD COLUMN "failureReason" TEXT;
UPDATE "RefundExecution" r SET account = 'fake', "amountCents" = o."totalCents", currency = o.currency
 FROM "Order" o WHERE o."tenantId" = r."tenantId" AND o.id = r."orderId";
ALTER TABLE "RefundExecution" ALTER COLUMN "account" SET NOT NULL, ALTER COLUMN "amountCents" SET NOT NULL,
 ALTER COLUMN "currency" SET NOT NULL;

CREATE TABLE "ShopifyConnection" (
    "tenantId" VARCHAR(80) NOT NULL,
    "shopDomain" VARCHAR(120) NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "connectedBy" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopifyConnection_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "Conversation" (
    "tenantId" VARCHAR(80) NOT NULL,
    "id" VARCHAR(80) NOT NULL,
    "userId" VARCHAR(80) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("tenantId", "id")
);
CREATE INDEX "Conversation_tenantId_userId_updatedAt_idx" ON "Conversation"("tenantId", "userId", "updatedAt");

CREATE TABLE "ConversationMessage" (
    "tenantId" VARCHAR(80) NOT NULL,
    "conversationId" VARCHAR(80) NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "text" TEXT NOT NULL,
    "citations" JSONB,
    "actions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("tenantId", "conversationId", "seq"),
    CONSTRAINT "ConversationMessage_conversation_fkey" FOREIGN KEY ("tenantId", "conversationId")
      REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
