import { expect, it } from "vitest";
import { documentNotice } from "../src/documentStatus";

const now = Date.parse("2026-09-30T10:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const doc = (status: string, extra: { failureCode?: string | null; updatedAt?: string; lockedAt?: string | null } = {}) =>
  ({ status, failureCode: null, updatedAt: ago(0), lockedAt: null, ...extra });

it.each([
  ["embedding_failed", "Bedrock"], ["storage_failed", "support technique"], ["indexing_failed", "L’indexation a échoué"], [null, "L’indexation a échoué"],
])("explains an indexing failure (%s)", (failureCode, text) => {
  expect(documentNotice(doc("failed", { failureCode }), now)).toContain(text);
});

it("flags a document still queued after two minutes, when no worker claims it", () => {
  expect(documentNotice(doc("queued", { updatedAt: ago(1) }), now)).toBeNull();
  expect(documentNotice(doc("queued", { updatedAt: ago(3) }), now)).toContain("semble arrêté");
});

it("flags an indexing task whose lease expired without being reclaimed", () => {
  expect(documentNotice(doc("processing", { lockedAt: ago(4) }), now)).toBeNull();
  expect(documentNotice(doc("processing", { lockedAt: ago(7) }), now)).toContain("semble arrêté");
});

it.each(["draft", "published", "withdrawn"])("shows nothing for a settled %s document", (status) => {
  expect(documentNotice(doc(status, { updatedAt: ago(60) }), now)).toBeNull();
});
