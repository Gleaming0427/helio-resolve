import { afterEach, expect, it, vi } from "vitest";
import { DomainError, TenantId } from "@helio/domain";
import type { KnowledgeHit } from "@helio/application";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/env.js", () => ({}));
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-bedrock-runtime")>(),
  BedrockRuntimeClient: class { send = mocks.send; },
}));

import { BedrockSupportAgent, citedAnswer } from "../src/agent.js";

afterEach(() => { vi.resetAllMocks(); });
const tenantId = TenantId.of("ten_TEST123");
const ask = (agent: BedrockSupportAgent, message: string, history: { role: "user" | "assistant"; text: string }[] = []) =>
  agent.answer({ tenantId, userId: "usr_TEST123", message, history });
const reply = (text: string) => ({ output: { message: { content: [{ text }] } } });
const toolCall = (name: string, input: unknown, toolUseId = "call1") => ({ output: { message: { content: [{ toolUse: { toolUseId, name, input } }] } } });

it("applies the workspace language and tone to the model request", async () => {
  mocks.send.mockResolvedValue(reply("Done."));
  await ask(new BedrockSupportAgent({ search: vi.fn() }, vi.fn(), { locale: "en-US", responseTone: "concise" }), "Bonjour");
  const system = mocks.send.mock.calls[0]![0].input.system[0].text;
  expect(system).toContain("Reply in English.");
  expect(system).toContain("Use short, direct answers.");
});

it("sends the conversation so far before the new question", async () => {
  mocks.send.mockResolvedValue(reply("Oui, elle est payée."));
  await ask(new BedrockSupportAgent({ search: vi.fn() }, vi.fn()), "Et elle est payée ?", [
    { role: "user", text: "Où en est la commande #1001 ?" }, { role: "assistant", text: "Elle est expédiée." },
  ]);
  // The agent appends the model's reply to the same array afterwards.
  expect(mocks.send.mock.calls[0]![0].input.messages.slice(0, 3)).toEqual([
    { role: "user", content: [{ text: "Où en est la commande #1001 ?" }] },
    { role: "assistant", content: [{ text: "Elle est expédiée." }] },
    { role: "user", content: [{ text: "Et elle est payée ?" }] },
  ]);
});

it.each([false, true])("sends knowledge results as an object, including empty results (hasHits=%s)", async (hasHits) => {
  const hits: KnowledgeHit[] = hasHits ? [{
    chunkId: "chunk1", documentTitle: "Livraison", text: "Express : 9,90 euros", score: 0.9,
  }] : [];
  mocks.send.mockResolvedValueOnce(toolCall("search_knowledge", { query: "Livraison express" }, "search1")).mockImplementationOnce(async (command) => {
    expect(command.input.messages[2]).toEqual({ role: "user", content: [{
      toolResult: {
        toolUseId: "search1", status: "success", content: [{ json: { hits: hits.map(hit => ({ source: "S1", ...hit })) } }],
      },
    }] });
    return reply(hasHits ? "L’express coûte 9,90 euros [S1]." : "Réponse");
  });
  const search = vi.fn().mockResolvedValue(hits);
  const executeTool = vi.fn();
  const result = await ask(new BedrockSupportAgent({ search }, executeTool), "Quel prix pour la livraison express ?");
  expect(search).toHaveBeenCalledWith({ tenantId, query: "Livraison express", limit: 5 });
  expect(executeTool).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(result).toEqual(hasHits ? { text: "L’express coûte 9,90 euros.", citations: ["Livraison"], actions: [] } : { text: "Réponse", citations: [], actions: [] });
});

it("cites only the documents the answer relies on", async () => {
  const hit = (documentTitle: string, chunkId: string): KnowledgeHit => ({ chunkId, documentTitle, text: "…", score: 0.8 });
  mocks.send.mockResolvedValueOnce(toolCall("search_knowledge", { query: "Retours" })).mockImplementationOnce(async (command) => {
    const { hits } = command.input.messages[2].content[0].toolResult.content[0].json;
    // Two chunks of one document share its marker.
    expect(hits.map((h: { source: string }) => h.source)).toEqual(["S1", "S1", "S2"]);
    return reply("L’étiquette coûte 4,50 euros [S2] et le délai est de 45 jours [S2] [S7].");
  });
  const search = vi.fn().mockResolvedValue([hit("Livraison", "c1"), hit("Livraison", "c2"), hit("Retours", "c3")]);
  const result = await ask(new BedrockSupportAgent({ search }, vi.fn()), "Retours ?");
  expect(result).toEqual({ text: "L’étiquette coûte 4,50 euros et le délai est de 45 jours.", citations: ["Retours"], actions: [] });
});

it("shows no sources when the answer cites none", async () => {
  expect(citedAnswer("Je n’ai pas trouvé cette information.", new Map([["Livraison", "S1"]])))
    .toEqual({ text: "Je n’ai pas trouvé cette information.", citations: [] });
});

it("never shows a sources block with raw tool results written by the model", () => {
  const text = "La proposition apr_9233fe88c5dd4695 a été créée.\n\n<sources>\n  S1: {\"toolResult\": [{\"approvalId\": \"apr_9233fe88c5dd4695\"}]}\n</sources>";
  expect(citedAnswer(text, new Map())).toEqual({ text: "La proposition apr_9233fe88c5dd4695 a été créée.", citations: [] });
  expect(citedAnswer("Créée. <sources>S1: {\"raw\": true}", new Map()).text).toBe("Créée.");
});

it("returns the refund proposals and tickets it created as actions", async () => {
  mocks.send
    .mockResolvedValueOnce(toolCall("propose_refund", { orderId: "#1001", reason: "Produit cassé" }, "call1"))
    .mockResolvedValueOnce(toolCall("create_ticket", { subject: "Colis", body: "Suivi transporteur" }, "call2"))
    .mockResolvedValueOnce(reply("Proposition apr_TEST123 et ticket tkt_TEST123 créés."));
  const executeTool = vi.fn(async (name: string) => name === "propose_refund" ? { approvalId: "apr_TEST123", status: "pending" } : { id: "tkt_TEST123", status: "open" });
  const result = await ask(new BedrockSupportAgent({ search: vi.fn() }, executeTool), "Rembourse et ouvre un ticket");
  expect(result.actions).toEqual([{ type: "refund_proposed", approvalId: "apr_TEST123" }, { type: "ticket_created", ticketId: "tkt_TEST123" }]);
});

it("lets the model explain a business refusal instead of failing the whole answer", async () => {
  mocks.send.mockResolvedValueOnce(toolCall("propose_refund", { orderId: "#1001", reason: "Produit cassé" })).mockImplementationOnce(async (command) => {
    expect(command.input.messages[2].content[0].toolResult).toEqual({
      toolUseId: "call1", status: "error", content: [{ text: "La demande dépasse le délai de remboursement de 30 jours." }],
    });
    return reply("Cette commande n’est plus remboursable.");
  });
  const executeTool = vi.fn().mockRejectedValue(new DomainError("La demande dépasse le délai de remboursement de 30 jours."));
  const result = await ask(new BedrockSupportAgent({ search: vi.fn() }, executeTool), "Rembourse #1001");
  expect(result).toEqual({ text: "Cette commande n’est plus remboursable.", citations: [], actions: [] });
});

it("still fails on an unexpected tool error", async () => {
  mocks.send.mockResolvedValueOnce(toolCall("get_order", { orderId: "#1001" }));
  const executeTool = vi.fn().mockRejectedValue(new Error("connection refused"));
  await expect(ask(new BedrockSupportAgent({ search: vi.fn() }, executeTool), "#1001 ?")).rejects.toThrow("connection refused");
});

it("searches the authenticated tenant's knowledge even if the model names another tenant", async () => {
  mocks.send.mockResolvedValueOnce(toolCall("search_knowledge", { query: "Livraison", tenantId: "ten_OTHER123", limit: 500 }, "search1"))
    .mockResolvedValueOnce(reply("Réponse"));
  const search = vi.fn().mockResolvedValue([]);
  await ask(new BedrockSupportAgent({ search }, vi.fn()), "Livraison ?");
  expect(search).toHaveBeenCalledExactlyOnceWith({ tenantId, query: "Livraison", limit: 5 });
});
