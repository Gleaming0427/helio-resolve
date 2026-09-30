import type { Document } from "./api";

// A running worker claims a queued document within seconds; an expired lease
// (5 minutes) is reclaimed as soon as a worker runs.
const QUEUE_DELAY_MS = 2 * 60_000;
const LEASE_MS = 6 * 60_000;
const failures: Record<string, string> = {
  embedding_failed: "Le service d’indexation (Bedrock) n’a pas répondu. Réessayez dans quelques minutes.",
  storage_failed: "L’index n’a pas pu être enregistré. Réessayez ; si l’échec se répète, prévenez votre support technique.",
};
const stalled = "L’indexation n’avance pas : le service d’indexation semble arrêté. La version publiée précédente reste disponible ; prévenez votre support technique.";

/** Mirrors the API rule: never while the chat can use it or a worker is indexing it. */
export const canDelete = (doc: Pick<Document, "status" | "publishedVersion">) =>
  !doc.publishedVersion && ["draft", "failed", "withdrawn"].includes(doc.status);

export function documentNotice(doc: Pick<Document, "status" | "failureCode" | "updatedAt" | "lockedAt">, now = Date.now()): string | null {
  if (doc.status === "failed") return failures[doc.failureCode ?? ""] ?? "L’indexation a échoué. Réessayez ; si l’échec se répète, prévenez votre support technique.";
  if (doc.status === "queued" && now - Date.parse(doc.updatedAt) > QUEUE_DELAY_MS) return stalled;
  if (doc.status === "processing" && doc.lockedAt && now - Date.parse(doc.lockedAt) > LEASE_MS) return stalled;
  return null;
}
