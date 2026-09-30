import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { PrismaConversations } from "../src/conversations.js";

const url = process.env.HELIO_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/helio_refund_test") throw new Error("A dedicated helio_refund_test database is required.");
const tenantId = "ten_CONVERSATION", alice = "usr_ALICE123", bob = "usr_BOB12345";
let db: PrismaClient, conversations: PrismaConversations;
const reply = (text: string) => ({ text, citations: ["Livraison"], actions: [{ type: "ticket_created" as const, ticketId: "tkt_TEST123" }] });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  ({ prisma: db } = await import("../src/prisma.js"));
  const { PrismaConversations } = await import("../src/conversations.js");
  conversations = new PrismaConversations(db);
});
beforeEach(async () => { await db.conversation.deleteMany({ where: { tenantId } }); });
afterAll(async () => { await db?.$disconnect(); });

it("keeps the turns of a conversation in order for follow-up questions", async () => {
  const id = await conversations.append({ tenantId, userId: alice, message: "Où en est la commande #1001 ?", reply: reply("Elle est expédiée.") });
  expect(await conversations.append({ tenantId, userId: alice, conversationId: id, message: "Et elle est payée ?", reply: reply("Oui.") })).toBe(id);
  expect(await conversations.history(tenantId, alice, id)).toEqual([
    { role: "user", text: "Où en est la commande #1001 ?" }, { role: "assistant", text: "Elle est expédiée." },
    { role: "user", text: "Et elle est payée ?" }, { role: "assistant", text: "Oui." },
  ]);
  expect(await conversations.get(tenantId, alice, id)).toMatchObject({ title: "Où en est la commande #1001 ?", messages: [
    { role: "user" }, { role: "assistant", citations: ["Livraison"], actions: [{ type: "ticket_created", ticketId: "tkt_TEST123" }] }, { role: "user" }, { role: "assistant" },
  ] });
  expect(await conversations.list(tenantId, alice)).toEqual([expect.objectContaining({ id })]);
});

it("sends the model only the latest turns, starting with a question", async () => {
  let id: string | undefined;
  for (let i = 1; i <= 15; i++) id = await conversations.append({ tenantId, userId: alice, conversationId: id, message: `Question ${i}`, reply: reply(`Réponse ${i}`) });
  const history = await conversations.history(tenantId, alice, id!);
  expect(history).toHaveLength(20);
  expect(history[0]).toEqual({ role: "user", text: "Question 6" });
  expect(history.at(-1)).toEqual({ role: "assistant", text: "Réponse 15" });
});

it("keeps a conversation private to the member who holds it", async () => {
  const id = await conversations.append({ tenantId, userId: alice, message: "Client mécontent", reply: reply("Je note.") });
  await expect(conversations.history(tenantId, bob, id)).rejects.toThrow("introuvable");
  await expect(conversations.get(tenantId, bob, id)).rejects.toThrow("introuvable");
  await expect(conversations.append({ tenantId, userId: bob, conversationId: id, message: "Intrusion", reply: reply("…") })).rejects.toThrow("introuvable");
  await expect(conversations.history("ten_OTHER123", alice, id)).rejects.toThrow("introuvable");
  expect(await conversations.list(tenantId, bob)).toEqual([]);
  expect(await db.conversationMessage.count({ where: { tenantId, conversationId: id } })).toBe(2);
});
