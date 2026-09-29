import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
export type CurrentUser = {
  userId: string;
  tenantId: string;
  roles: string[];
};
declare module "fastify" {
  interface FastifyRequest {
    currentUser: CurrentUser;
  }
}
function devIdentity(): CurrentUser | null {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTH_MODE !== "dev"
  ) {
    return null;
  }
  return {
    userId: process.env.DEV_USER_ID ?? "usr_DEMO123",
    tenantId: process.env.DEV_TENANT_ID ?? "ten_DEMO123",
    roles: (process.env.DEV_ROLES ?? "support_manager,tenant_admin")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  };
}
async function verifyCognitoToken(token: string): Promise<CurrentUser> {
  const region = process.env.AWS_REGION;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!region || !userPoolId || !clientId) {
    throw new Error("Cognito configuration is incomplete");
  }
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
  });
  if (payload.token_use !== "access") {
    throw new Error("Expected a Cognito access token");
  }
  if (payload.client_id !== clientId) {
    throw new Error("Token was issued for another client");
  }
  const groups = Array.isArray(payload["cognito:groups"])
    ? payload["cognito:groups"].map(String)
    : [];
  const tenantGroups = groups.filter((group) => group.startsWith("tenant__"));
  if (!payload.sub || tenantGroups.length !== 1) {
    throw new Error(
      "The user must belong to exactly one tenant__<TenantId> group",
    );
  }
  const tenantId = tenantGroups[0]!.slice("tenant__".length);
  const roles = groups.filter((group) => !group.startsWith("tenant__"));
  return {
    userId: `usr_${String(payload.sub).replaceAll("-", "").slice(0, 16)}`,
    tenantId,
    roles,
  };
}
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const devUser = devIdentity();
  if (devUser) {
    request.currentUser = devUser;
    return;
  }
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  try {
    request.currentUser = await verifyCognitoToken(token);
  } catch {
    await reply.code(401).send({ error: "invalid_token" });
  }
}
export function requireRole(role: string) {
  return async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.currentUser.roles.includes(role)) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}
