import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { DomainError } from "@helio/domain";
import Fastify from "fastify";
import { z } from "zod";
import { authenticate, requireRole } from "./auth.js";
import { createAgent, tenantId, useCases } from "./container.js";
export async function buildApp() {
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization"],
    },
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? false,
    credentials: false,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  app.get("/health", async () => ({ ok: true }));
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
      preHandler: [authenticate, requireRole("support_manager")],
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
      preHandler: [authenticate, requireRole("support_manager")],
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
      preHandler: [authenticate, requireRole("tenant_admin")],
    },
    async (request, reply) => {
      const body = z
        .object({
          title: z.string().min(3).max(300),
          text: z.string().min(20).max(100_000),
        })
        .parse(request.body);
      const result = await useCases.submitKnowledge.execute({
        tenantId: request.currentUser.tenantId,
        actorId: request.currentUser.userId,
        title: body.title,
        text: body.text,
      });
      return reply.code(202).send(result);
    },
  );
  app.post(
    "/chat",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request) => {
      const body = z
        .object({
          message: z.string().min(1).max(4_000),
        })
        .parse(request.body);
      const agent = createAgent(request.currentUser);
      return agent.answer({
        tenantId: tenantId(request.currentUser.tenantId),
        userId: request.currentUser.userId,
        message: body.message,
      });
    },
  );
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
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
    return reply.code(500).send({
      error: "internal_error",
    });
  });
  return app;
}
