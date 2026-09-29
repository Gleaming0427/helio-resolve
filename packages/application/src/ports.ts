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
  findById(tenantId: TenantId, ticketId: TicketId): Promise<Ticket | null>;
  save(ticket: Ticket): Promise<void>;
}

export interface ApprovalRepository {
  findById(
    tenantId: TenantId,
    approvalId: ApprovalId,
  ): Promise<Approval | null>;
  save(approval: Approval): Promise<void>;
}

/** Replays (including concurrent calls) with the same key and payment must return
 * the same refund without transferring funds twice, even after a timeout/restart.
 * Production adapters must enforce this at the payment provider. */
export interface PaymentGateway {
  refund(input: {
    paymentId: PaymentId;
    idempotencyKey: string;
  }): Promise<{ providerRefundId: string }>;
}

export type KnowledgeHit = {
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
  }): Promise<KnowledgeHit[]>;
}

export interface KnowledgeIngestion {
  submit(input: {
    tenantId: TenantId;
    title: string;
    text: string;
  }): Promise<{ documentKey: string }>;
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

/** Durable intent, created only after explicit manager execution. */
export type RefundExecution = {
  tenantId: string;
  approvalId: string;
  orderId: string;
  paymentId: string;
  actorId: string;
  idempotencyKey: string;
  providerRefundId: string | null;
};

export interface RefundExecutionRepository {
  find(tenantId: TenantId, approvalId: ApprovalId): Promise<RefundExecution | null>;
  create(execution: RefundExecution): Promise<void>;
  complete(tenantId: TenantId, approvalId: ApprovalId, providerRefundId: string): Promise<void>;
  pending(limit: number): Promise<RefundExecution[]>;
}

export interface TransactionContext {
  orders: OrderRepository;
  tickets: TicketRepository;
  approvals: ApprovalRepository;
  audit: AuditLog;
  refunds: RefundExecutionRepository;
}

export interface UnitOfWork {
  /** All writes commit together. Callback may be retried; no external side effects. */
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
