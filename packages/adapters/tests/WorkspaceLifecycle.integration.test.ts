import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";
import { TenantId } from "@helio/domain";
import type { PrismaClient } from "@prisma/client";
import type { PrismaWorkspaceRepository } from "../src/workspace.js";
import type { PgVectorKnowledgeSearch } from "../src/knowledge.js";
import type { LogEntry } from "../src/log.js";

const url = process.env.HELIO_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/helio_refund_test") throw new Error("A dedicated helio_refund_test database is required.");
const a = "ten_WORKSPACEA", b = "ten_WORKSPACEB", admin = "usr_WORKADMINA";
let db: PrismaClient, repo: PrismaWorkspaceRepository, search: PgVectorKnowledgeSearch, pool: Pool;
let knownEmail: typeof import("../src/workspace.js").knownEmail;
let work: typeof import("../src/document-worker.js").processNextDocument;
const embedding = async () => [1, ...Array<number>(1023).fill(0)];
const find = (tenant = a) => search.search({ tenantId: TenantId.of(tenant), query: "Livraison", limit: 5 });
const draft = () => repo.saveDocument({ tenantId: a, actorId: admin, title: "Livraison", text: "La livraison express coûte 9,90 euros et prend 48 heures." });
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  ({ prisma: db } = await import("../src/prisma.js"));
  const { PrismaWorkspaceRepository } = await import("../src/workspace.js");
  ({ knownEmail } = await import("../src/workspace.js"));
  const { PgVectorKnowledgeSearch } = await import("../src/knowledge.js");
  ({ processNextDocument: work } = await import("../src/document-worker.js"));
  repo = new PrismaWorkspaceRepository(db);
  pool = new Pool({ connectionString: url });
  search = new PgVectorKnowledgeSearch(embedding, pool);
});
beforeEach(async () => {
  await db.$executeRaw`DELETE FROM knowledge_chunk WHERE tenant_id IN (${a},${b})`;
  await db.workspaceInvitation.deleteMany({ where: { tenantId: { in: [a, b] } } });
  await db.settingsRevision.deleteMany({ where: { tenantId: { in: [a, b] } } });
  await db.tenant.deleteMany({ where: { id: { in: [a, b] } } });
  await repo.resolveMember(admin, { tenantId: a, role: "tenant_admin" });
  await repo.resolveMember("usr_WORKADMINB", { tenantId: b, role: "tenant_admin" });
});
afterAll(async () => { await pool?.end(); await db?.$disconnect(); });

it("persists settings history and rejects stale updates", async () => {
  const values = { tenantId: a, actorId: admin, expectedVersion: 1, name: "Acme", locale: "en-US", responseTone: "concise", refundApprovalThresholdCents: 9950 };
  await repo.updateSettings(values);
  await expect(repo.updateSettings({ ...values, name: "Lost update" })).rejects.toThrow("modifiés");
  const workspace = await repo.get(a);
  expect(workspace.name).toBe("Acme");
  expect(workspace.settings).toMatchObject({ version: 2, locale: "en-US", refundApprovalThresholdCents: 9950 });
  expect(workspace.revisions.map(r => r.version)).toEqual([2, 1]);
  expect((await repo.get(b)).settings?.version).toBe(1);
});

it("consumes an invitation once and applies suspension despite old identity groups", async () => {
  const invitation = await repo.invite(a, admin, "support_manager");
  await repo.acceptInvitation(invitation.token, "usr_WORKINVITED");
  await expect(repo.acceptInvitation(invitation.token, "usr_SECOND")).rejects.toThrow("invalide");
  expect(await repo.resolveMember("usr_WORKINVITED")).toMatchObject({ tenantId: a, role: "support_manager" });
  await repo.updateMember(a, "usr_WORKINVITED", "support_agent", true);
  expect(await repo.resolveMember("usr_WORKINVITED")).toMatchObject({ role: "support_agent" });
  await repo.updateMember(a, "usr_WORKINVITED", "support_agent", false);
  expect(await repo.resolveMember("usr_WORKINVITED", { tenantId: a, role: "tenant_admin" })).toBeNull();
});

it("keeps a placeholder email until the member's verified email is recorded", async () => {
  const invitation = await repo.invite(a, admin, "support_agent");
  await repo.acceptInvitation(invitation.token, "usr_WORKEMAIL");
  const member = () => db.membership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: a, userId: "usr_WORKEMAIL" } } });
  expect(knownEmail((await member()).email)).toBeNull();
  await repo.updateEmail("usr_WORKEMAIL", "alice@example.com");
  expect(knownEmail((await member()).email)).toBe("alice@example.com");
  expect(knownEmail((await db.membership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: a, userId: admin } } })).email)).toBeNull();
});

it("rejects cross-company, revoked and expired invitations and protects the last admin", async () => {
  const invitation = await repo.invite(a, admin, "support_agent");
  await expect(repo.acceptInvitation(invitation.token, "usr_WORKADMINB")).rejects.toThrow("autre espace");
  await expect(repo.acceptInvitation(invitation.token, admin)).rejects.toThrow("déjà membre");
  await expect(repo.updateMember(a, admin, "support_agent", true)).rejects.toThrow("administrateur");
  await expect(repo.updateMember(b, admin, "tenant_admin", false)).rejects.toThrow("introuvable");
  await repo.revokeInvitation(b, invitation.id);
  expect((await repo.get(a)).invitations[0]?.revokedAt).toBeNull();
  await repo.revokeInvitation(a, invitation.id);
  await expect(repo.acceptInvitation(invitation.token, "usr_NEW")).rejects.toThrow("invalide");
  const expired = await repo.invite(a, admin, "support_agent");
  await db.workspaceInvitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
  await expect(repo.acceptInvitation(expired.token, "usr_NEW")).rejects.toThrow("expirée");
});

it("publishes, searches, versions and withdraws a procedure within its tenant", async () => {
  const doc = await draft();
  expect(await find()).toEqual([]);
  await expect(repo.document(b, doc.id)).rejects.toThrow("introuvable");
  await expect(repo.publish(b, doc.id, 1)).rejects.toThrow();
  await expect(repo.withdraw(b, doc.id)).rejects.toThrow();
  await expect(repo.saveDocument({ tenantId: b, actorId: admin, id: doc.id, expectedVersion: 1, title: "Attack", text: "An attempted cross tenant edit." })).rejects.toThrow();
  await repo.publish(a, doc.id, 1);
  await work(db, embedding);
  expect((await repo.document(a, doc.id)).status).toBe("published");
  expect((await find())[0]?.text).toContain("9,90");
  expect(await find(b)).toEqual([]);
  await repo.saveDocument({ tenantId: a, actorId: admin, id: doc.id, expectedVersion: 1, title: "Livraison actualisée", text: "La livraison express coûte désormais 12 euros." });
  expect((await find())[0]?.text).toContain("9,90");
  await repo.publish(a, doc.id, 2);
  await work(db, embedding);
  expect((await find())[0]?.text).toContain("12 euros");
  expect((await repo.document(a, doc.id)).versions).toHaveLength(2);
  await repo.withdraw(a, doc.id);
  expect(await find()).toEqual([]);
});

it("keeps the published version on indexing failure and supports retry", async () => {
  const doc = await draft();
  await repo.publish(a, doc.id, 1); await work(db, embedding);
  await repo.saveDocument({ tenantId: a, actorId: admin, id: doc.id, expectedVersion: 1, title: "Updated", text: "Nouvelle procédure de livraison express à 12 euros." });
  await repo.publish(a, doc.id, 2);
  const logs: LogEntry[] = [];
  await work(db, async () => { throw Object.assign(new Error("ThrottlingException from https://user:pw@bedrock"), { name: "ThrottlingException" }); }, entry => { logs.push(entry); });
  expect(await repo.document(a, doc.id)).toMatchObject({ status: "failed", failureCode: "embedding_failed", publishedVersion: 1 });
  expect(logs).toEqual([expect.objectContaining({ level: "error", event: "document_indexing_failed", tenantId: a, documentId: doc.id, version: 2,
    failureCode: "embedding_failed", error: expect.objectContaining({ type: "ThrottlingException", message: "ThrottlingException from https://***@bedrock" }) })]);
  expect((await find())[0]?.text).toContain("9,90");
  await repo.publish(a, doc.id, 2); await work(db, embedding);
  expect((await find())[0]?.text).toContain("12 euros");
});

it("cannot republish a document withdrawn during embedding", async () => {
  const doc = await draft(); await repo.publish(a, doc.id, 1);
  await work(db, async () => { await repo.withdraw(a, doc.id); return embedding(); });
  expect(await repo.document(a, doc.id)).toMatchObject({ status: "withdrawn", publishedVersion: null });
  expect(await find()).toEqual([]);
});

it("deletes a document only once the chat can no longer use it, with its versions and vectors", async () => {
  const doc = await draft();
  await repo.publish(a, doc.id, 1); await work(db, embedding);
  await expect(repo.deleteDocument(a, doc.id)).rejects.toThrow("Retirez");
  await repo.saveDocument({ tenantId: a, actorId: admin, id: doc.id, expectedVersion: 1, title: "Livraison", text: "Nouvelle version encore en brouillon." });
  // A draft of a published document keeps the published version in the chat.
  await expect(repo.deleteDocument(a, doc.id)).rejects.toThrow("Retirez");
  await repo.withdraw(a, doc.id);
  await expect(repo.deleteDocument(b, doc.id)).rejects.toThrow("Retirez");
  await repo.deleteDocument(a, doc.id);
  await expect(repo.document(a, doc.id)).rejects.toThrow("introuvable");
  expect(await db.knowledgeDocumentVersion.count({ where: { tenantId: a, documentId: doc.id } })).toBe(0);
  expect(await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM knowledge_chunk WHERE document_id=${doc.id}`).toEqual([{ n: 0n }]);
});

it("refuses to delete a document while it is being indexed", async () => {
  const doc = await draft();
  await repo.publish(a, doc.id, 1);
  await expect(repo.deleteDocument(a, doc.id)).rejects.toThrow("Retirez");
  await db.knowledgeDocument.update({ where: { tenantId_id: { tenantId: a, id: doc.id } }, data: { status: "processing", lockedAt: new Date() } });
  await expect(repo.deleteDocument(a, doc.id)).rejects.toThrow("Retirez");
});

it("records when a document was queued and logs each indexing outcome", async () => {
  const doc = await draft();
  await db.knowledgeDocument.update({ where: { tenantId_id: { tenantId: a, id: doc.id } }, data: { updatedAt: new Date(0) } });
  const before = Date.now();
  // The UI detects a stopped worker from this timestamp.
  expect((await repo.publish(a, doc.id, 1)).updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  const logs: LogEntry[] = [];
  await work(db, embedding, entry => { logs.push(entry); });
  expect(logs).toMatchObject([{ level: "info", event: "document_indexed", tenantId: a, documentId: doc.id, version: 1, chunks: 1 }]);
  await repo.withdraw(a, doc.id);
  await repo.publish(a, doc.id, 1);
  await work(db, async () => { await repo.withdraw(a, doc.id); return embedding(); }, entry => { logs.push(entry); });
  expect(logs.at(-1)).toMatchObject({ level: "info", event: "document_indexing_superseded", documentId: doc.id });
});

it("reclaims an abandoned indexing task", async () => {
  const doc = await draft();
  await db.knowledgeDocument.update({ where: { tenantId_id: { tenantId: a, id: doc.id } }, data: { status: "processing", lockedAt: new Date(0) } });
  await work(db, embedding);
  expect((await repo.document(a, doc.id)).status).toBe("published");
});

it("allows only one concurrent editor to replace a document version", async () => {
  const doc = await draft();
  const edit = (text: string) => repo.saveDocument({ tenantId: a, actorId: admin, id: doc.id, expectedVersion: 1, title: "Livraison", text });
  const results = await Promise.allSettled([edit("First replacement procedure for delivery."), edit("Second replacement procedure for delivery.")]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await repo.document(a, doc.id)).versions).toHaveLength(2);
});

it("does not allow concurrent administrators to remove the last administrator", async () => {
  const invitation = await repo.invite(a, admin, "tenant_admin");
  await repo.acceptInvitation(invitation.token, "usr_WORKADMIN2");
  const results = await Promise.allSettled([repo.updateMember(a, admin, "support_agent", true), repo.updateMember(a, "usr_WORKADMIN2", "support_agent", true)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await db.membership.count({ where: { tenantId: a, role: "tenant_admin", active: true } })).toBe(1);
});

it("rolls back publication if a new vector cannot be stored", async () => {
  const doc = await draft();
  await repo.publish(a, doc.id, 1); await work(db, embedding);
  await repo.saveDocument({ tenantId: a, actorId: admin, id: doc.id, expectedVersion: 1, title: "New", text: "New delivery procedure for the same company." });
  await repo.publish(a, doc.id, 2);
  const logs: LogEntry[] = [];
  await work(db, async () => [1], entry => { logs.push(entry); }); // Deliberately invalid pgvector dimension.
  expect(await repo.document(a, doc.id)).toMatchObject({ status: "failed", failureCode: "storage_failed", publishedVersion: 1 });
  expect(logs).toMatchObject([{ level: "error", event: "document_indexing_failed", failureCode: "storage_failed" }]);
  expect((await find())[0]?.text).toContain("9,90");
});

it("enforces the configured refund ceiling and currency", async () => {
  await db.order.upsert({ where: { tenantId_id: { tenantId: a, id: "ord_WORKSPACE" } }, create: { tenantId: a, id: "ord_WORKSPACE", status: "paid", totalCents: 5000, currency: "EUR", paymentId: "pay_WORKSPACE" }, update: { currency: "EUR" } });
  await db.approval.upsert({ where: { tenantId_id: { tenantId: a, id: "apr_WORKSPACE" } }, create: { tenantId: a, id: "apr_WORKSPACE", orderId: "ord_WORKSPACE", status: "pending", reason: "Damaged product" }, update: {} });
  expect(await repo.mayManageRefund(a, "apr_WORKSPACE", false)).toBe(false);
  await repo.updateSettings({ tenantId: a, actorId: admin, expectedVersion: 1, name: "Acme", locale: "fr-FR", responseTone: "professional", refundApprovalThresholdCents: 5000 });
  expect(await repo.mayManageRefund(a, "apr_WORKSPACE", false)).toBe(true);
  expect(await repo.mayManageRefund(b, "apr_WORKSPACE", false)).toBe(false);
  await db.order.update({ where: { tenantId_id: { tenantId: a, id: "ord_WORKSPACE" } }, data: { currency: "USD" } });
  expect(await repo.mayManageRefund(a, "apr_WORKSPACE", false)).toBe(false);
  expect(await repo.mayManageRefund(a, "apr_WORKSPACE", true)).toBe(true);
});
