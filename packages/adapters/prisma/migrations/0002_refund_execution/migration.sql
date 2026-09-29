CREATE TABLE "RefundExecution" (
    "tenantId" VARCHAR(80) NOT NULL,
    "approvalId" VARCHAR(80) NOT NULL,
    "orderId" VARCHAR(80) NOT NULL,
    "paymentId" VARCHAR(80) NOT NULL,
    "actorId" VARCHAR(80) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefundExecution_pkey" PRIMARY KEY ("tenantId", "approvalId")
);
CREATE UNIQUE INDEX "RefundExecution_idempotencyKey_key" ON "RefundExecution"("idempotencyKey");
CREATE UNIQUE INDEX "RefundExecution_tenantId_orderId_key" ON "RefundExecution"("tenantId", "orderId");
CREATE INDEX "RefundExecution_providerRefundId_createdAt_idx" ON "RefundExecution"("providerRefundId", "createdAt");
