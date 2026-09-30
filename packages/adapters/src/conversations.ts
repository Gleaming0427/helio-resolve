import { randomUUID } from "node:crypto";
import type { AgentAction, AgentReply, ConversationTurn } from "@helio/application";
import { DomainError } from "@helio/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

// Enough context for follow-up questions while bounding the model input.
const HISTORY_TURNS = 20;

/** Chat memory. A conversation is only visible to the member who holds it. */
export class PrismaConversations {
  constructor(private readonly db: PrismaClient = prisma) {}

  private async owned(tenantId: string, userId: string, id: string) {
    const conversation = await this.db.conversation.findUnique({ where: { tenantId_id: { tenantId, id } } });
    if (!conversation || conversation.userId !== userId) throw new DomainError("Conversation introuvable.");
    return conversation;
  }

  async history(tenantId: string, userId: string, id: string): Promise<ConversationTurn[]> {
    await this.owned(tenantId, userId, id);
    const messages = await this.db.conversationMessage.findMany({
      where: { tenantId, conversationId: id }, orderBy: { seq: "desc" }, take: HISTORY_TURNS,
    });
    return messages.reverse().map(message => ({ role: message.role as ConversationTurn["role"], text: message.text }));
  }

  /** Stores a question with its answer, so the history always alternates user/assistant. */
  async append(input: { tenantId: string; userId: string; conversationId?: string | undefined; message: string; reply: AgentReply }) {
    const { tenantId, userId, message, reply } = input;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async tx => {
          let id = input.conversationId;
          if (id) {
            const conversation = await tx.conversation.findUnique({ where: { tenantId_id: { tenantId, id } } });
            if (!conversation || conversation.userId !== userId) throw new DomainError("Conversation introuvable.");
            await tx.conversation.update({ where: { tenantId_id: { tenantId, id } }, data: { updatedAt: new Date() } });
          } else {
            id = randomUUID();
            await tx.conversation.create({ data: { tenantId, id, userId, title: message.replace(/\s+/g, " ").trim().slice(0, 120) } });
          }
          const last = await tx.conversationMessage.findFirst({ where: { tenantId, conversationId: id }, orderBy: { seq: "desc" } });
          const seq = (last?.seq ?? 0) + 1;
          await tx.conversationMessage.createMany({ data: [
            { tenantId, conversationId: id, seq, role: "user", text: message },
            { tenantId, conversationId: id, seq: seq + 1, role: "assistant", text: reply.text,
              citations: reply.citations, actions: reply.actions as unknown as Prisma.InputJsonValue },
          ] });
          return id;
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) continue;
        throw error;
      }
    }
  }

  async list(tenantId: string, userId: string) {
    return this.db.conversation.findMany({
      where: { tenantId, userId }, orderBy: { updatedAt: "desc" }, take: 30,
      select: { id: true, title: true, updatedAt: true },
    });
  }

  async get(tenantId: string, userId: string, id: string) {
    const conversation = await this.owned(tenantId, userId, id);
    const messages = await this.db.conversationMessage.findMany({ where: { tenantId, conversationId: id }, orderBy: { seq: "asc" } });
    return {
      id: conversation.id,
      title: conversation.title,
      messages: messages.map(message => ({
        role: message.role,
        text: message.text,
        citations: (message.citations ?? []) as string[],
        actions: (message.actions ?? []) as AgentAction[],
      })),
    };
  }
}
export const conversations = new PrismaConversations();
