import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The workspace script runs Vite from apps/web, while the shared .env lives
// at the repository root.
const envDir = fileURLToPath(new URL("../..", import.meta.url));

// Every API call carries a bearer token: a build must not target plain HTTP,
// except a local API on this machine.
export function assertSecureApiUrl(value: string | undefined): void {
  const url = value ? URL.parse(value) : null;
  const local = url?.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url?.protocol !== "https:" && !local) {
    throw new Error("VITE_API_URL must use https:// (plain http:// is only allowed for localhost)");
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === "build") assertSecureApiUrl(loadEnv(mode, envDir, "VITE_").VITE_API_URL);
  return {
    plugins: [react()],
    envDir,
  };
});
