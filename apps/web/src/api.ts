import { auth } from "./auth";
const baseUrl = import.meta.env.VITE_API_URL;
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await auth.token();
  const devUser = auth.devUser?.();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body != null ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(devUser ? { "X-Dev-User": devUser } : {}),
      ...(init.headers ?? {}),
    },
  }).catch(() => { throw new Error("Impossible de joindre Helio. Vérifiez votre connexion et que l’API est démarrée."); });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const messages: Record<number, string> = {
      400: "Vérifiez les champs de votre demande.",
      401: "Votre session n’est pas valide. Reconnectez-vous.",
      403: "Vous n’avez pas les droits nécessaires pour cette action.",
      404: "Cet élément est introuvable dans votre espace.",
      409: "Cette action n’est pas possible dans l’état actuel. Rechargez les informations.",
      413: "Le contenu envoyé est trop volumineux.",
      429: "Trop de demandes. Patientez une minute avant de réessayer.",
    };
    // Business refusals carry a message written for the user (refund window, four-eyes…).
    const domainErrors = ["DomainError", "ApprovalError", "RefundNotAllowed", "RefundRejected"];
    const detail = response.status === 409 && body && typeof body === "object" && "error" in body && domainErrors.includes(String(body.error))
      && "message" in body && typeof body.message === "string" ? body.message : undefined;
    const expected = detail ?? messages[response.status];
    if (expected) throw new Error(expected);
    // Only unexpected failures need a reference for the support team to find the logs.
    const requestId = body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string"
      ? body.requestId : response.headers?.get("x-request-id");
    throw new Error("Le service a rencontré un problème. Réessayez dans quelques instants." + (requestId ? ` Référence : ${requestId}.` : ""));
  }
  return response.json() as Promise<T>;
}
export type OrderView = { id: string; reference: string | null; status: string; totalCents: number; currency: string; paidAt: string | null };
export type ApprovalView = {
  id: string;
  orderId: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "executed";
  proposedBy: string | null;
  approvedBy: string | null;
  order: OrderView | null;
  execution?: { status: "pending" | "refunded" | "failed"; providerRefundId: string | null; failureReason: string | null } | null;
};
export type AgentAction = { type: "refund_proposed"; approvalId: string } | { type: "ticket_created"; ticketId: string };
export type ChatReply = { text: string; citations: string[]; actions: AgentAction[]; conversationId: string };
export type ConversationMessage = { role: "user" | "assistant"; text: string; citations: string[]; actions: AgentAction[] };
export type Ticket = { id: string; subject: string; body: string; status: "open" | "resolved"; orderId: string | null; orderReference?: string | null; createdBy: string; resolvedBy: string | null };
export type ShopifyStatus = { connection: { shopDomain: string; connectedAt: string; connectedBy: string } | null };
export type Settings = { version: number; locale: string; responseTone: string; refundApprovalThresholdCents: number };
export type Document = { id: string; title: string; status: string; currentVersion: number; publishedVersion: number | null; updatedAt: string; lockedAt: string | null; failureCode: string | null };
export type DocumentDetail = Document & { versions: { version: number; title: string; content: string; createdAt: string }[] };
export type Workspace = {
  id: string; name: string; settings: Settings;
  members: { userId: string; email: string | null; role: string; active: boolean }[];
  revisions: (Settings & { name: string; actorId: string; createdAt: string })[];
  invitations: { id: string; role: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }[];
};
export const api = {
  me: () => request<{ userId: string; tenantId: string; roles: string[]; email: string | null }>("/me"),
  syncEmail: (idToken: string) => request<{ email: string }>("/me/email", { method: "PUT", body: JSON.stringify({ idToken }) }),
  workspace: () => request<Workspace>("/workspace"),
  updateSettings: (input: Omit<Settings, "version"> & { expectedVersion: number; name: string }) => request<Settings>("/workspace/settings", { method: "PUT", body: JSON.stringify(input) }),
  invite: (role: string) => request<{ token: string }>("/workspace/invitations", { method: "POST", body: JSON.stringify({ role }) }),
  acceptInvitation: (token: string) => request("/invitations/accept", { method: "POST", body: JSON.stringify({ token }) }),
  revokeInvitation: (id: string) => request(`/workspace/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updateMember: (input: { userId: string; role: string; active: boolean }) => request(`/workspace/members/${encodeURIComponent(input.userId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  documents: () => request<Document[]>("/knowledge/documents"),
  document: (id: string) => request<DocumentDetail>(`/knowledge/documents/${encodeURIComponent(id)}`),
  saveDocument: (input: { id?: string; expectedVersion?: number; title: string; text: string }) => request<Document>(input.id ? `/knowledge/documents/${encodeURIComponent(input.id)}` : "/knowledge/documents", { method: input.id ? "PUT" : "POST", body: JSON.stringify(input) }),
  publishDocument: (doc: Document) => request(`/knowledge/documents/${encodeURIComponent(doc.id)}/publish`, { method: "POST", body: JSON.stringify({ version: doc.currentVersion }) }),
  deleteDocument: (id: string) => request(`/knowledge/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  withdrawDocument: (id: string) => request(`/knowledge/documents/${encodeURIComponent(id)}/withdraw`, { method: "POST" }),
  chat: (input: { message: string; conversationId?: string | undefined }) =>
    request<ChatReply>("/chat", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  conversations: () => request<{ id: string; title: string; updatedAt: string }[]>("/conversations"),
  conversation: (id: string) => request<{ id: string; title: string; messages: ConversationMessage[] }>(`/conversations/${encodeURIComponent(id)}`),
  tickets: (status: "open" | "resolved" | "all") => request<Ticket[]>(`/tickets?status=${status}`),
  resolveTicket: (id: string) => request<Ticket>(`/tickets/${encodeURIComponent(id)}/resolve`, { method: "POST" }),
  approvals: (status: "open" | "closed") => request<ApprovalView[]>(`/approvals?status=${status}`),
  reject: (id: string) => request<{ approvalId: string; status: string }>(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  shopify: () => request<ShopifyStatus>("/workspace/shopify"),
  connectShopify: (input: { shopDomain: string; accessToken: string }) => request<{ shopDomain: string; shopName: string }>("/workspace/shopify", { method: "PUT", body: JSON.stringify(input) }),
  disconnectShopify: () => request("/workspace/shopify", { method: "DELETE" }),
  getOrder: (id: string) =>
    request<{
      id: string;
      status: string;
      totalCents: number;
      currency: string;
      paidAt: string | null;
    }>(`/orders/${encodeURIComponent(id)}`),
  getApproval: (id: string) =>
    request<ApprovalView>(`/approvals/${encodeURIComponent(id)}`),
  approve: (id: string) =>
    request<{ approvalId: string; status: string }>(
      `/approvals/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
    ),
  execute: (id: string) =>
    request<{ status: string; providerRefundId: string }>(
      `/approvals/${encodeURIComponent(id)}/execute`,
      { method: "POST" },
    ),
};
