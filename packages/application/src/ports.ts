import type {
  Approval,
  ApprovalId,
  Order,
  OrderId,
  PaymentId,
  TenantId,
  Ticket,
  TicketId,
} from "@helio/domain";

export interface OrderRepository {
  findById(tenantId: TenantId, orderId: OrderId): Promise<Order | null>;
  save(order: Order): Promise<void>;
}

export interface TicketRepository {
  findById(ticketId: TicketId): Promise<Ticket | null>;
  save(ticket: Ticket): Promise<void>;
}

export interface ApprovalRepository {
  findById(approvalId: ApprovalId): Promise<Approval | null>;
  save(approval: Approval): Promise<void>;
}

export interface PaymentGateway {
  refund(input: {
    paymentId: PaymentId;
    idempotencyKey: string;
  }): Promise<{ providerRefundId: string }>;
}

export type knowledgeHit = {
  chunkId: string;
  documentTitle: string;
  text: string;
  score: number;
};

export interface KnowledgeSearch {
  search(input: {
    tenantId: TenantId;
    query: string;
    limit: number;
  }): Promise<knowledgeHit[]>;
}

export interface knowledgeIngestion {
  submit(input: {
    tenantId: TenantId;
    documentTitle: string;
    chunks: { chunkId: string; text: string }[];
  }): Promise<void>;
}

export interface AuditLog {
  record(input: {
    tenantId: TenantId;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
export type AgentReply = {
  text: string;
  citations: string[];
};

export interface SupportAgent {
  answer(input: {
    tenantId: TenantId;
    userId: string;
    message: string;
  }): Promise<AgentReply>;
}
