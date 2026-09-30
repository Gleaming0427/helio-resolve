// The URL hash keeps the current screen across reloads (#settings, #knowledge…).
const views = ["chat", "tickets", "approvals", "knowledge", "settings"];

export function viewFromHash(hash: string): string {
  const view = hash.replace(/^#/, "");
  return views.includes(view) ? view : "chat";
}

/** The API enforces these roles; the UI only avoids showing an unusable screen. */
export function canOpen(view: string, roles: string[]): boolean {
  if (view === "chat" || view === "tickets") return true;
  if (view === "approvals") return roles.includes("support_manager");
  return views.includes(view) && roles.includes("tenant_admin");
}
