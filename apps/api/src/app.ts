import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { DomainError } from "@helio/domain";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, authenticateIdentity, requireRole, verifiedEmail } from "./auth.js";
import { createAgent, tenantId, useCases } from "./container.js";
import { conversations, knownEmail, quotaStore, workspaceRepository } from "@helio/adapters";
import { shopifyConnections } from "./payments.js";
import { loggableError } from "@helio/adapters/log";
// Behind the ALB, request.ip must be the client address it appends, not the ALB's.
// Only the configured hops are trusted: addresses a client prepends are ignored.
function trustedProxyHops(value = process.env.TRUST_PROXY_HOPS) {
  if (!value) return false;
  if (!/^\d+$/.test(value)) throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
  const hops = Number(value);
  // Fastify 5 ignores a numeric trustProxy: hop 0 is the socket peer (the ALB).
  return (_address: string, hop: number) => hop < hops;
}
export async function buildApp(options: { logStream?: { write(line: string): void } } = {}) {
  const app = Fastify({
    trustProxy: trustedProxyHops(),
    // Unique across instances and restarts, so a reference shown to a user finds its log lines.
    genReqId: () => randomUUID(),
    logger: {
      redact: ["req.headers.authorization"],
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? false,
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: ["x-request-id"],
  });
  // Per client IP and per instance: a coarse anti-abuse guard. The WAF IP rule is
  // the limit shared by all instances.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  // Shared by users of one tenant and by all API instances (PostgreSQL counter),
  // so the ceiling does not multiply with the number of tasks.
  function tenantQuota(group: string, max: number) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { count, retryAfterSeconds } = await quotaStore.hit(`${group}:${request.currentUser.tenantId}`, 60);
      if (count > max) {
        return reply.header("Retry-After", retryAfterSeconds).code(429).send({ error: "quota_exceeded" });
      }
    };
  }
  const chatQuota = tenantQuota("chat", 20);
  const documentQuota = tenantQuota("documents", 10);
  const refundPolicy = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!await workspaceRepository.mayManageRefund(request.currentUser.tenantId, id, request.currentUser.roles.includes("tenant_admin"))) {
      return reply.code(403).send({ error: "administrator_required" });
    }
  };
  app.get("/health", async () => ({ ok: true }));
  app.get("/me", { preHandler: [authenticate] }, async request => request.currentUser);
  // The access token carries no email: the client proves it with its Cognito ID token.
  app.put("/me/email", { preHandler: [authenticate] }, async (request, reply) => {
    const { idToken } = z.object({ idToken: z.string().min(1).max(8192) }).parse(request.body);
    let email: string;
    try {
      email = await verifiedEmail(idToken, request.currentUser.userId);
    } catch {
      return reply.code(400).send({ error: "invalid_id_token" });
    }
    await workspaceRepository.updateEmail(request.currentUser.userId, email);
    return { email };
  });
  app.post("/invitations/accept", { preHandler: [authenticateIdentity] }, async request => {
    const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    await workspaceRepository.acceptInvitation(token, request.currentUser.userId);
    return { accepted: true };
  });
  app.get("/workspace", { preHandler: [authenticate, requireRole("tenant_admin")] }, async (request) => {
    const workspace = await workspaceRepository.get(request.currentUser.tenantId);
    const members = workspace.memberships.map(member => ({ ...member, email: knownEmail(member.email) }));
    return { id: workspace.id, name: workspace.name, settings: workspace.settings, members, documents: workspace.documents, revisions: workspace.revisions, invitations: workspace.invitations };
  });
  app.put("/workspace/settings", { preHandler: [authenticate, requireRole("tenant_admin")] }, async (request) => {
    const body = z.object({ expectedVersion: z.number().int().positive(), name: z.string().trim().min(2).max(200), locale: z.enum(["fr-FR", "en-US"]), responseTone: z.enum(["professional", "warm", "concise"]), refundApprovalThresholdCents: z.number().int().min(0).max(10_000_000) }).parse(request.body);
    return workspaceRepository.updateSettings({ tenantId: request.currentUser.tenantId, actorId: request.currentUser.userId, ...body });
  });
  app.post("/workspace/invitations", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    const { role } = z.object({ role: z.enum(["support_agent", "support_manager", "tenant_admin"]) }).parse(request.body);
    return workspaceRepository.invite(request.currentUser.tenantId, request.currentUser.userId, role);
  });
  app.delete("/workspace/invitations/:id", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    await workspaceRepository.revokeInvitation(request.currentUser.tenantId, z.object({id:z.string()}).parse(request.params).id); return { revoked: true };
  });
  app.patch("/workspace/members/:id", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    const { role, active } = z.object({ role: z.enum(["support_agent", "support_manager", "tenant_admin"]), active: z.boolean() }).parse(request.body);
    return workspaceRepository.updateMember(request.currentUser.tenantId, z.object({id:z.string()}).parse(request.params).id, role, active);
  });
  app.get("/knowledge/documents", { preHandler: [authenticate, requireRole("tenant_admin")] }, async (request) => {
    const workspace = await workspaceRepository.get(request.currentUser.tenantId);
    return workspace.documents;
  });
  app.get("/knowledge/documents/:id", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => workspaceRepository.document(request.currentUser.tenantId, z.object({id:z.string()}).parse(request.params).id));
  app.put("/knowledge/documents/:id", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    const body = z.object({ title:z.string().trim().min(3).max(300), text:z.string().min(20).max(100000), expectedVersion:z.number().int().positive() }).parse(request.body);
    return workspaceRepository.saveDocument({ ...body, id:z.object({id:z.string()}).parse(request.params).id, tenantId:request.currentUser.tenantId, actorId:request.currentUser.userId });
  });
  app.post("/knowledge/documents/:id/publish", { preHandler: [authenticate, requireRole("tenant_admin"), documentQuota] }, async request => {
    const { version } = z.object({version:z.number().int().positive()}).parse(request.body);
    return workspaceRepository.publish(request.currentUser.tenantId,z.object({id:z.string()}).parse(request.params).id,version);
  });
  app.delete("/knowledge/documents/:id", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    await workspaceRepository.deleteDocument(request.currentUser.tenantId, z.object({id:z.string()}).parse(request.params).id); return { deleted: true };
  });
  app.post("/knowledge/documents/:id/withdraw", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    await workspaceRepository.withdraw(request.currentUser.tenantId,z.object({id:z.string()}).parse(request.params).id); return { withdrawn:true };
  });
  app.get("/orders/:id", { preHandler: [authenticate] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return useCases.getOrder.execute({
      tenantId: request.currentUser.tenantId,
      orderId: params.id,
    });
  });
  app.post(
    "/tickets",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = z
        .object({
          subject: z.string().min(3).max(200),
          body: z.string().min(1).max(5_000),
          orderId: z.string().min(1).max(80).optional(),
        })
        .parse(request.body);
      const result = await useCases.createTicket.execute({
        tenantId: request.currentUser.tenantId,
        userId: request.currentUser.userId,
        ...body,
      });
      return reply.code(201).send(result);
    },
  );
  app.get("/tickets", { preHandler: [authenticate] }, async request => {
    const { status } = z.object({ status: z.enum(["open", "resolved", "all"]).default("open") }).parse(request.query);
    return useCases.listTickets.execute({ tenantId: request.currentUser.tenantId, status: status === "all" ? null : status });
  });
  app.post("/tickets/:id/resolve", { preHandler: [authenticate] }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return useCases.resolveTicket.execute({ tenantId: request.currentUser.tenantId, ticketId: id, userId: request.currentUser.userId });
  });
  app.post(
    "/refund-proposals",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = z
        .object({
          orderId: z.string(),
          reason: z.string().min(3).max(500),
        })
        .parse(request.body);
      const result = await useCases.proposeRefund.execute({
        tenantId: request.currentUser.tenantId,
        actorId: request.currentUser.userId,
        ...body,
      });
      return reply.code(201).send(result);
    },
  );
  app.get("/approvals", { preHandler: [authenticate, requireRole("support_manager")] }, async request => {
    const { status } = z.object({ status: z.enum(["open", "closed"]).default("open") }).parse(request.query);
    return useCases.listApprovals.execute({
      tenantId: request.currentUser.tenantId,
      statuses: status === "open" ? ["pending", "approved"] : ["rejected", "executed"],
    });
  });
  // Rejecting moves no money: any manager may do it, whatever the amount.
  app.post("/approvals/:id/reject", { preHandler: [authenticate, requireRole("support_manager")] }, async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return useCases.rejectApproval.execute({ tenantId: request.currentUser.tenantId, approvalId: id, managerUserId: request.currentUser.userId });
  });
  app.get(
    "/approvals/:id",
    {
      preHandler: [authenticate, requireRole("support_manager")],
    },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      return useCases.getApproval.execute({
        tenantId: request.currentUser.tenantId,
        approvalId: params.id,
      });
    },
  );
  app.post(
    "/approvals/:id/approve",
    {
      preHandler: [authenticate, requireRole("support_manager"), refundPolicy],
    },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      return useCases.approveAction.execute({
        tenantId: request.currentUser.tenantId,
        approvalId: params.id,
        managerUserId: request.currentUser.userId,
      });
    },
  );
  app.post(
    "/approvals/:id/execute",
    {
      preHandler: [authenticate, requireRole("support_manager"), refundPolicy],
    },
    async (request) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      return useCases.executeRefund.execute({
        tenantId: request.currentUser.tenantId,
        approvalId: params.id,
        managerUserId: request.currentUser.userId,
      });
    },
  );
  app.post(
    "/knowledge/documents",
    {
      preHandler: [authenticate, requireRole("tenant_admin"), documentQuota],
    },
    async (request, reply) => {
      const body = z
        .object({
          title: z.string().min(3).max(300),
          text: z.string().min(20).max(100_000),
        })
        .parse(request.body);
      const result = await workspaceRepository.saveDocument({
        tenantId: request.currentUser.tenantId,
        actorId: request.currentUser.userId,
        title: body.title,
        text: body.text,
      });
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/chat",
    {
      preHandler: [authenticate, chatQuota],
    },
    async (request) => {
      const body = z
        .object({
          message: z.string().min(1).max(4_000),
          conversationId: z.uuid().optional(),
        })
        .parse(request.body);
      const { tenantId: tenant, userId } = request.currentUser;
      const history = body.conversationId ? await conversations.history(tenant, userId, body.conversationId) : [];
      const agent = await createAgent(request.currentUser);
      const reply = await agent.answer({
        tenantId: tenantId(tenant),
        userId,
        message: body.message,
        history,
      });
      const conversationId = await conversations.append({ tenantId: tenant, userId, conversationId: body.conversationId, message: body.message, reply });
      return { ...reply, conversationId };
    },
  );
  app.get("/conversations", { preHandler: [authenticate] }, async request =>
    conversations.list(request.currentUser.tenantId, request.currentUser.userId));
  app.get("/conversations/:id", { preHandler: [authenticate] }, async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return conversations.get(request.currentUser.tenantId, request.currentUser.userId, id);
  });
  // The access token is write-only: it is checked with Shopify, stored encrypted and never returned.
  app.get("/workspace/shopify", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request =>
    ({ connection: await shopifyConnections.status(request.currentUser.tenantId) }));
  app.put("/workspace/shopify", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    const body = z.object({
      shopDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/),
      accessToken: z.string().trim().regex(/^shp[a-z]{2}_[A-Za-z0-9]{16,}$/),
    }).parse(request.body);
    return shopifyConnections.connect({ tenantId: request.currentUser.tenantId, actorId: request.currentUser.userId, ...body });
  });
  app.delete("/workspace/shopify", { preHandler: [authenticate, requireRole("tenant_admin")] }, async request => {
    await shopifyConnections.disconnect(request.currentUser.tenantId, request.currentUser.userId);
    return { disconnected: true };
  });
  app.setErrorHandler((error, request, reply) => {
    // Never serialize provider/Prisma errors in responses: their messages may contain
    // secrets or customer data. The logs keep the cause (credentials scrubbed) under
    // the request ID returned to the client. Rejected client requests are not incidents.
    const clientStatus = error instanceof z.ZodError ? 400 : error instanceof DomainError ? 409
      : error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" &&
        error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : null;
    if (clientStatus) {
      request.log.info({ statusCode: clientStatus, errorType: error instanceof Error ? error.name : typeof error }, "Request rejected");
    } else {
      request.log.error({ error: loggableError(error) }, "Request failed");
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        details: error.issues,
      });
    }
    if (error instanceof DomainError) {
      return reply.code(409).send({
        error: error.name,
        message: error.message,
      });
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 && error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({ error: "invalid_request" });
    }
    return reply.code(500).send({
      error: "internal_error",
      requestId: request.id,
    });
  });
  return app;
}
