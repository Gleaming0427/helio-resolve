import { auth } from "./auth";
const baseUrl = import.meta.env.VITE_API_URL;
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await auth.token();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
export type ApprovalView = {
  id: string;
  orderId: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "executed";
  approvedBy: string | null;
};
export const api = {
  chat: (message: string) =>
    request<{ text: string; citations: string[] }>("/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
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
  submitKnowledge: (input: { title: string; text: string }) =>
    request<{ status: "queued"; documentKey: string }>("/knowledge/documents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
