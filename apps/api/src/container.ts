import { payments } from "./payments.js";
import {
  ApproveAction,
  CreateTicket,
  ExecuteRefund,
  GetApproval,
  GetOrderContext,
  ProposeRefund,
  SubmitKnowledgeDocument,
} from "@helio/application";
import {
  BedrockSupportAgent,
  PgVectorKnowledgeSearch,
  PrismaApprovalRepository,
  PrismaAuditLog,
  PrismaOrderRepository,
  PrismaUnitOfWork,
  S3SqsKnowledgeIngestion,
} from "@helio/adapters";
import { TenantId } from "@helio/domain";
import { z } from "zod";
const orders = new PrismaOrderRepository();
const unitOfWork = new PrismaUnitOfWork();
const approvals = new PrismaApprovalRepository();

const knowledge = new PgVectorKnowledgeSearch();
const audit = new PrismaAuditLog();
const ingestion = new S3SqsKnowledgeIngestion();
export const useCases = {
  getOrder: new GetOrderContext(orders),
  getApproval: new GetApproval(approvals),
  createTicket: new CreateTicket(unitOfWork),
  proposeRefund: new ProposeRefund(unitOfWork),
  approveAction: new ApproveAction(unitOfWork),
  executeRefund: new ExecuteRefund(unitOfWork, payments),
  submitKnowledge: new SubmitKnowledgeDocument(ingestion, audit),
};
const GetOrderTool = z.object({
  orderId: z.string(),
});
const CreateTicketTool = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(1).max(5_000),
});
const ProposeRefundTool = z.object({
  orderId: z.string(),
  reason: z.string().min(3).max(500),
});
export function createAgent(context: { tenantId: string; userId: string }) {
  return new BedrockSupportAgent(knowledge, async (name, input) => {
    if (name === "get_order") {
      const parsed = GetOrderTool.parse(input);
      return useCases.getOrder.execute({
        tenantId: context.tenantId,
        orderId: parsed.orderId,
      });
    }
    if (name === "create_ticket") {
      const parsed = CreateTicketTool.parse(input);
      return useCases.createTicket.execute({
        tenantId: context.tenantId,
        userId: context.userId,
        subject: parsed.subject,
        body: parsed.body,
      });
    }
    if (name === "propose_refund") {
      const parsed = ProposeRefundTool.parse(input);
      return useCases.proposeRefund.execute({
        tenantId: context.tenantId,
        actorId: context.userId,
        orderId: parsed.orderId,
        reason: parsed.reason,
      });
    }
    throw new Error(`Unknown tool: ${name}`);
  });
}
export function tenantId(value: string): TenantId {
  return TenantId.of(value);
}
