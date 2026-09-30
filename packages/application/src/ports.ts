import type {
  Approval,
  ApprovalId,
  ApprovalStatus,
  Money,
  Order,
  OrderId,
  PaymentId,
  TenantId,
  Ticket,
  TicketId,
  TicketStatus,
} from "@helio/domain";

export interface OrderRepository {
  findById(tenantId: TenantId, orderId: OrderId): Promise<Order | null>;
  save(order: Order): Promise<void>;
}

export interface TicketRepository {
  findById(tenantId: TenantId, ticketId: TicketId): Promise<Ticket | null>;
  save(ticket: Ticket): Promise<void>;
  /** Most recent first. */
  list(tenantId: TenantId, status: TicketStatus | null, limit: number): Promise<Ticket[]>;
}

export interface ApprovalRepository {
  findById(
    tenantId: TenantId,
    approvalId: ApprovalId,
  ): Promise<Approval | null>;
  save(approval: Approval): Promise<void>;
  /** Oldest first: the queue a manager works through. */
  list(tenantId: TenantId, statuses: ApprovalStatus[], limit: number): Promise<Approval[]>;
}

/** The tenant's store (e.g. Shopify), source of truth for its orders. */
export interface OrderSource {
  /** `connected: false` when the tenant has no store: Helio's own records are used. */
  find(tenantId: TenantId, reference: string): Promise<{ connected: false } | { connected: true; order: Order | null }>;
}

/** Replays (including concurrent calls) with the same key and payment must return
 * the same refund without transferring funds twice, even after a timeout/restart.
 * Production adapters must enforce this at the payment provider. */
export interface PaymentGateway {
  /** The account that would execute a refund for this tenant now, e.g. "shopify:acme.myshopify.com".
   * Stored with the intent: a replay never runs against another account. */
  account(tenantId: TenantId): Promise<string>;
  /** Throws RefundRejected when the provider definitively refuses; any other error leaves the
   * outcome unknown and the intent is retried with the same key. */
  refund(input: {
    tenantId: TenantId;
    account: string;
    orderId: OrderId;
    paymentId: PaymentId;
    amount: Money;
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

/** Records created by the assistant, shown to the user as links instead of relying on the text. */
export type AgentAction =
  | { type: "refund_proposed"; approvalId: string }
  | { type: "ticket_created"; ticketId: string };

export type AgentReply = {
  text: string;
  citations: string[];
  actions: AgentAction[];
};

export type ConversationTurn = { role: "user" | "assistant"; text: string };

export interface SupportAgent {
  answer(input: {
    tenantId: TenantId;
    userId: string;
    message: string;
    /** Previous turns of the same conversation, oldest first. */
    history: ConversationTurn[];
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
  account: string;
  amountCents: number;
  currency: string;
  providerRefundId: string | null;
  /** Set when the provider definitively refused: the intent is never retried. */
  failureReason: string | null;
};

export interface RefundExecutionRepository {
  find(tenantId: TenantId, approvalId: ApprovalId): Promise<RefundExecution | null>;
  create(execution: RefundExecution): Promise<void>;
  complete(tenantId: TenantId, approvalId: ApprovalId, providerRefundId: string): Promise<void>;
  fail(tenantId: TenantId, approvalId: ApprovalId, reason: string): Promise<void>;
  /** Intents whose outcome is unknown: neither completed nor refused. */
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
