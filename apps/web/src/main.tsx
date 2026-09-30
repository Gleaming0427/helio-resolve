import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { auth } from "./auth";
const queryClient = new QueryClient();
function renderApp(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
async function boot(): Promise<void> {
  const invitation = new URLSearchParams(location.search).get("invite");
  if (invitation && /^[a-f0-9]{64}$/.test(invitation)) {
    sessionStorage.setItem("helio-invitation", invitation);
    history.replaceState({}, "", location.pathname);
  }
  if (auth.isDev) {
    renderApp();
    return;
  }
  if (location.pathname === "/callback") {
    await auth.completeLogin();
    history.replaceState({}, "", "/");
  }
  const user = await auth.getUser();
  if (!user || user.expired) {
    await auth.login();
    return;
  }
  renderApp();
}
void boot();
