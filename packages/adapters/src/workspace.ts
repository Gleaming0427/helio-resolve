import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "@helio/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

export const rolesFor = (role: string) => role === "tenant_admin" ? ["tenant_admin", "support_manager"] : [role];
// Stored until the member proves their email with a Cognito ID token.
const placeholderEmail = (userId: string) => `${userId}@local.invalid`;
export const knownEmail = (email: string) => email.endsWith("@local.invalid") ? null : email;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export class PrismaWorkspaceRepository {
  constructor(private readonly db: PrismaClient = prisma) {}
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.db.$transaction(work, { isolationLevel: "Serializable" }); }
      catch (error) {
        if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) continue;
        throw error;
      }
    }
  }
  async resolveMember(userId: string, bootstrap?: { tenantId: string; role: string }) {
    const existing = await this.db.membership.findMany({ where: { userId } });
    // Revocation is authoritative, even if the old Cognito token still has groups.
    if (existing.length) return existing.length === 1 && existing[0]!.active ? existing[0]! : null;
    if (!bootstrap || bootstrap.role !== "tenant_admin") return null;
    return this.transaction(async tx => {
      const tenant = await tx.tenant.findUnique({ where: { id: bootstrap.tenantId } });
      if (tenant && await tx.membership.count({ where: { tenantId: tenant.id } })) return null;
      const name = `Entreprise ${bootstrap.tenantId}`;
      await tx.tenant.upsert({ where: { id: bootstrap.tenantId }, create: { id: bootstrap.tenantId, name, slug: bootstrap.tenantId }, update: {} });
      const settings = await tx.tenantSettings.upsert({ where: { tenantId: bootstrap.tenantId }, create: { tenantId: bootstrap.tenantId, updatedBy: userId }, update: {} });
      await tx.settingsRevision.upsert({ where: { tenantId_version: { tenantId: bootstrap.tenantId, version: settings.version } },
        create: { tenantId: bootstrap.tenantId, version: settings.version, name: tenant?.name ?? name, locale: settings.locale, responseTone: settings.responseTone, refundApprovalThresholdCents: settings.refundApprovalThresholdCents, actorId: userId }, update: {} });
      return tx.membership.create({ data: { tenantId: bootstrap.tenantId, userId, email: placeholderEmail(userId), role: "tenant_admin" } });
    });
  }
  async get(tenantId: string) {
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { settings: true, memberships: { orderBy: { createdAt: "asc" } }, documents: { orderBy: { updatedAt: "desc" } } } });
    const revisions = await this.db.settingsRevision.findMany({ where: { tenantId }, orderBy: { version: "desc" } });
    const invitations = await this.db.workspaceInvitation.findMany({ where: { tenantId }, select: { id: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true }, orderBy: { createdAt: "desc" } });
    return { ...tenant, revisions, invitations };
  }
  async mayManageRefund(tenantId: string, approvalId: string, isAdmin: boolean) {
    if (isAdmin) return true;
    const approval = await this.db.approval.findUnique({ where: { tenantId_id: { tenantId, id: approvalId } } });
    if (!approval) return false;
    const order = await this.db.order.findUnique({ where: { tenantId_id: { tenantId, id: approval.orderId } } });
    const settings = await this.db.tenantSettings.findUnique({ where: { tenantId } });
    return !!order && !!settings && order.currency === "EUR" && order.totalCents <= settings.refundApprovalThresholdCents;
  }
  async updateSettings(input: { tenantId: string; actorId: string; expectedVersion: number; name: string; locale: string; responseTone: string; refundApprovalThresholdCents: number }) {
    return this.transaction(async tx => {
      const { tenantId, actorId, expectedVersion, name, ...values } = input;
      const changed = await tx.tenantSettings.updateMany({ where: { tenantId, version: expectedVersion }, data: { ...values, version: { increment: 1 }, updatedBy: actorId } });
      if (!changed.count) throw new DomainError("Les réglages ont été modifiés. Rechargez la page.");
      await tx.tenant.update({ where: { id: tenantId }, data: { name } });
      await tx.settingsRevision.create({ data: { tenantId, version: expectedVersion + 1, actorId, name, ...values } });
      return tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
    });
  }
  async invite(tenantId: string, actorId: string, role: string) {
    const token = randomBytes(32).toString("hex");
    const invitation = await this.db.workspaceInvitation.create({ data: { tenantId, createdBy: actorId, role, tokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000) } });
    return { id: invitation.id, token, expiresAt: invitation.expiresAt };
  }
  async revokeInvitation(tenantId: string, id: string) {
    await this.db.workspaceInvitation.updateMany({ where: { tenantId, id, acceptedAt: null }, data: { revokedAt: new Date() } });
  }
  async acceptInvitation(token: string, userId: string) {
    return this.transaction(async tx => {
      const invitation = await tx.workspaceInvitation.findUnique({ where: { tokenHash: hash(token) } });
      if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) throw new DomainError("Invitation invalide ou expirée.");
      const existing = await tx.membership.findMany({ where: { userId } });
      if (existing.some(m => m.tenantId !== invitation.tenantId)) throw new DomainError("Ce compte appartient déjà à un autre espace.");
      if (existing.some(m => m.active)) throw new DomainError("Ce compte est déjà membre de cet espace.");
      const member = await tx.membership.upsert({ where: { tenantId_userId: { tenantId: invitation.tenantId, userId } }, create: { tenantId: invitation.tenantId, userId, email: placeholderEmail(userId), role: invitation.role }, update: { active: true, role: invitation.role } });
      await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
      return member;
    });
  }
  /** Callers pass an email already verified by the identity provider for this user. */
  async updateEmail(userId: string, email: string) {
    await this.db.membership.updateMany({ where: { userId }, data: { email } });
  }
  async updateMember(tenantId: string, userId: string, role: string, active: boolean) {
    return this.transaction(async tx => {
      const current = await tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
      if (!current) throw new DomainError("Membre introuvable.");
      if (current.active && current.role === "tenant_admin" && (!active || role !== "tenant_admin") &&
        await tx.membership.count({ where: { tenantId, active: true, role: "tenant_admin" } }) <= 1) throw new DomainError("Conservez au moins un administrateur actif.");
      return tx.membership.update({ where: { tenantId_userId: { tenantId, userId } }, data: { role, active } });
    });
  }
  async document(tenantId: string, id: string) {
    const doc = await this.db.knowledgeDocument.findUnique({ where: { tenantId_id: { tenantId, id } }, include: { versions: { orderBy: { version: "desc" } } } });
    if (!doc) throw new DomainError("Document introuvable.");
    return doc;
  }
  async saveDocument(input: { tenantId: string; actorId: string; title: string; text: string; id?: string; expectedVersion?: number }) {
    return this.transaction(async tx => {
      const { tenantId, actorId, title, text } = input;
      const id = input.id ?? randomUUID();
      const current = await tx.knowledgeDocument.findUnique({ where: { tenantId_id: { tenantId, id } } });
      if (input.id && (!current || current.currentVersion !== input.expectedVersion)) throw new DomainError("Document modifié ou introuvable. Rechargez-le.");
      const version = (current?.currentVersion ?? 0) + 1;
      await tx.knowledgeDocument.upsert({ where: { tenantId_id: { tenantId, id } }, create: { tenantId, id, title, sourceKey: `${tenantId}/${id}.txt`, status: "draft", createdBy: actorId }, update: { title, currentVersion: version, status: "draft", failureCode: null, lockedAt: null } });
      await tx.knowledgeDocumentVersion.create({ data: { tenantId, documentId: id, version, title, content: text, createdBy: actorId } });
      return tx.knowledgeDocument.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id } } });
    });
  }
  async publish(tenantId: string, id: string, expectedVersion: number) {
    const changed = await this.db.knowledgeDocument.updateMany({ where: { tenantId, id, currentVersion: expectedVersion, status: { in: ["draft", "failed", "withdrawn"] } }, data: { status: "queued", failureCode: null, lockedAt: null } });
    if (!changed.count) throw new DomainError("Document modifié ou déjà en traitement.");
    return this.document(tenantId, id);
  }
  /** Only a document the chat cannot use, and that no worker is indexing, can be deleted. */
  async deleteDocument(tenantId: string, id: string) {
    await this.transaction(async tx => {
      const deleted = await tx.knowledgeDocument.deleteMany({ where: { tenantId, id, publishedVersion: null, status: { in: ["draft", "failed", "withdrawn"] } } });
      if (!deleted.count) throw new DomainError("Retirez le document avant de le supprimer.");
      // Versions cascade; the vector index has no foreign key.
      await tx.$executeRaw`DELETE FROM knowledge_chunk WHERE tenant_id=${tenantId} AND document_id=${id}`;
    });
  }
  async withdraw(tenantId: string, id: string) {
    const changed = await this.db.knowledgeDocument.updateMany({ where: { tenantId, id }, data: { status: "withdrawn", publishedVersion: null, lockedAt: null } });
    if (!changed.count) throw new DomainError("Document introuvable.");
  }
}
export const workspaceRepository = new PrismaWorkspaceRepository();
