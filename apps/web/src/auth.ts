import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
const isDev = import.meta.env.VITE_AUTH_MODE === "dev";
const manager = isDev
  ? null
  : new UserManager({
      authority: import.meta.env.VITE_COGNITO_AUTHORITY,
      client_id: import.meta.env.VITE_COGNITO_CLIENT_ID,
      redirect_uri: import.meta.env.VITE_COGNITO_REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
      userStore: new WebStorageStateStore({
        store: window.sessionStorage,
      }),
    });
// Development only: the demo member this tab acts as (the API ignores it in production).
const DEV_USER_KEY = "helio-dev-user";
export const demoMembers = [
  { userId: "usr_DEMO123", label: "Administrateur de démo" },
  { userId: "usr_DEMOAGENT", label: "Conseiller de démo" },
];
export const auth = {
  isDev,
  devUser: (): string | null => {
    if (!isDev) return null;
    try { return sessionStorage.getItem(DEV_USER_KEY); } catch { return null; }
  },
  setDevUser: (userId: string) => {
    try { sessionStorage.setItem(DEV_USER_KEY, userId); sessionStorage.removeItem("helio-conversation"); } catch { /* private mode */ }
  },
  getUser: (): Promise<User | null> =>
    isDev ? Promise.resolve(null) : manager!.getUser(),
  login: async (): Promise<void> => {
    if (!isDev) {
      await manager!.signinRedirect();
    }
  },
  completeLogin: (): Promise<User> => manager!.signinRedirectCallback(),
  logout: async (): Promise<void> => {
    if (!isDev) {
      await manager!.signoutRedirect();
    }
  },
  /** The ID token and its email, which the API verifies before showing it to administrators. */
  identity: async (): Promise<{ idToken: string; email: string } | null> => {
    const user = isDev ? null : await manager!.getUser();
    return user?.id_token && user.profile.email ? { idToken: user.id_token, email: user.profile.email.toLowerCase() } : null;
  },
  token: async (): Promise<string | null> => {
    if (isDev) {
      return null;
    }
    const user = await manager!.getUser();
    return user?.access_token ?? null;
  },
};
export type AuthUser = User;
