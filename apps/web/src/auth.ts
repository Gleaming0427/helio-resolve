import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
const isDev = import.meta.env.VITE_AUTH_MODE === "dev";
const manager = new UserManager({
  authority: import.meta.env.VITE_COGNITO_AUTHORITY,
  client_id: import.meta.env.VITE_COGNITO_CLIENT_ID,
  redirect_uri: import.meta.env.VITE_COGNITO_REDIRECT_URI,
  response_type: "code",
  scope: "openid email profile",
  userStore: new WebStorageStateStore({
    store: window.sessionStorage,
  }),
});
export const auth = {
  isDev,
  getUser: (): Promise<User | null> => manager.getUser(),
  login: async (): Promise<void> => {
    if (!isDev) {
      await manager.signinRedirect();
    }
  },
  completeLogin: (): Promise<User> => manager.signinRedirectCallback(),
  logout: async (): Promise<void> => {
    if (!isDev) {
      await manager.signoutRedirect();
    }
  },
  token: async (): Promise<string | null> => {
    if (isDev) {
      return null;
    }
    const user = await manager.getUser();
    return user?.access_token ?? null;
  },
};
export type AuthUser = User;
