import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { TenantId } from "@helio/domain";
import { knownEmail, workspaceRepository, rolesFor } from "@helio/adapters";
import { z } from "zod";
export type CurrentUser = {
  userId: string;
  tenantId: string;
  roles: string[];
  /** Verified email of a workspace member; null until proven, absent before membership. */
  email?: string | null;
};
declare module "fastify" {
  interface FastifyRequest {
    currentUser: CurrentUser;
  }
}
function devIdentity(request: FastifyRequest): CurrentUser | null {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTH_MODE !== "dev"
  ) {
    return null;
  }
  // Local demos need two people (four-eyes approval): the web app may act as another
  // demo member. Membership still decides tenant and roles.
  const override = request.headers["x-dev-user"];
  return {
    userId: typeof override === "string" && /^usr_[A-Za-z0-9-]{6,64}$/.test(override) ? override : process.env.DEV_USER_ID ?? "usr_DEMO123",
    tenantId: process.env.DEV_TENANT_ID ?? "ten_DEMO123",
    roles: (process.env.DEV_ROLES ?? "support_manager,tenant_admin")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  };
}
// One key set per issuer for the process lifetime: jose caches the keys, refreshes
// them on an unknown key ID (rotation) and rate-limits refetches. A new key set per
// request would download the JWKS from Cognito on every API call.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function signingKeys(issuer: string) {
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    keySets.set(issuer, keys);
  }
  return keys;
}
function cognitoConfig() {
  const region = process.env.AWS_REGION;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!region || !userPoolId || !clientId) {
    throw new Error("Cognito configuration is incomplete");
  }
  return { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`, clientId };
}
const userIdFor = (sub: unknown) => `usr_${String(sub).replaceAll("-", "").slice(0, 16)}`;
/** The email Cognito verified for this user, proven by their ID token. */
export async function verifiedEmail(idToken: string, userId: string): Promise<string> {
  const { issuer, clientId } = cognitoConfig();
  const { payload } = await jwtVerify(idToken, signingKeys(issuer), { issuer, audience: clientId });
  if (payload.token_use !== "id") throw new Error("Expected a Cognito ID token");
  // Otherwise a member could attach another account's verified email to themselves.
  if (!payload.sub || userIdFor(payload.sub) !== userId) throw new Error("ID token belongs to another user");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("Email is not verified");
  return z.email().max(320).parse(payload.email).toLowerCase();
}
async function verifyCognitoToken(token: string): Promise<CurrentUser> {
  const { issuer, clientId } = cognitoConfig();
  const { payload } = await jwtVerify(token, signingKeys(issuer), {
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
  if (!payload.sub || tenantGroups.length > 1) {
    throw new Error(
      "The user must belong to exactly one tenant__<TenantId> group",
    );
  }
  const tenantId = tenantGroups.length ? TenantId.of(tenantGroups[0]!.slice("tenant__".length)).toString() : "";
  const roles = groups.filter((group) => !group.startsWith("tenant__"));
  return {
    userId: userIdFor(payload.sub),
    tenantId,
    roles,
  };
}
export async function authenticateIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const devUser = devIdentity(request);
  if (devUser) {
    request.currentUser = devUser;
    return;
  }
  const token = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
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
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticateIdentity(request, reply);
  if (reply.sent) return;
  const identity = request.currentUser;
  const bootstrap = identity.tenantId && identity.roles.includes("tenant_admin")
    ? { tenantId: identity.tenantId, role: "tenant_admin" } : undefined;
  const member = await workspaceRepository.resolveMember(identity.userId, bootstrap);
  if (!member) { await reply.code(403).send({ error: "membership_required" }); return; }
  request.currentUser = { userId: identity.userId, tenantId: member.tenantId, roles: rolesFor(member.role), email: knownEmail(member.email) };
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
