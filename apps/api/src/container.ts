import { payments, shopifyConnections } from "./payments.js";
import {
  ApproveAction,
  CreateTicket,
  ExecuteRefund,
  GetApproval,
  GetOrderContext,
  ListApprovals,
  ListTickets,
  OrderResolver,
  ProposeRefund,
  RejectApproval,
  ResolveTicket,
} from "@helio/application";
import {
  BedrockSupportAgent,
  PgVectorKnowledgeSearch,
  PrismaApprovalRepository,
  PrismaOrderRepository,
  PrismaRefundExecutions,
  PrismaTicketRepository,
  PrismaUnitOfWork,
  ShopifyOrderSource,
  prisma,
} from "@helio/adapters";
import { TenantId } from "@helio/domain";
import { z } from "zod";
const orders = new PrismaOrderRepository();
const unitOfWork = new PrismaUnitOfWork();
const approvals = new PrismaApprovalRepository();
// Orders come from the tenant's Shopify store when connected, from Helio's records otherwise.
const resolver = new OrderResolver(unitOfWork, new ShopifyOrderSource(shopifyConnections));

const knowledge = new PgVectorKnowledgeSearch();
export const useCases = {
  getOrder: new GetOrderContext(orders, resolver),
  getApproval: new GetApproval(approvals, orders, new PrismaRefundExecutions()),
  listApprovals: new ListApprovals(approvals, orders),
  createTicket: new CreateTicket(unitOfWork, resolver),
  listTickets: new ListTickets(new PrismaTicketRepository(), orders),
  resolveTicket: new ResolveTicket(unitOfWork),
  proposeRefund: new ProposeRefund(unitOfWork, resolver),
  approveAction: new ApproveAction(unitOfWork),
  rejectApproval: new RejectApproval(unitOfWork),
  executeRefund: new ExecuteRefund(unitOfWork, payments),
};
const GetOrderTool = z.object({
  orderId: z.string().min(1).max(80),
});
const CreateTicketTool = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(1).max(5_000),
  orderId: z.string().min(1).max(80).optional(),
});
const ProposeRefundTool = z.object({
  orderId: z.string().min(1).max(80),
  reason: z.string().min(3).max(500),
});
export async function createAgent(context: { tenantId: string; userId: string }) {
  const settings = await prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId: context.tenantId } });
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
        orderId: parsed.orderId,
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
  }, { locale: settings.locale, responseTone: settings.responseTone });
}
export function tenantId(value: string): TenantId {
  return TenantId.of(value);
}
