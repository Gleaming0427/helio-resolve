import { expect, it } from "vitest";
import { canOpen, viewFromHash } from "../src/views";

it.each([["#settings", "settings"], ["#knowledge", "knowledge"], ["", "chat"], ["#unknown", "chat"], ["#__proto__", "chat"]])(
  "reopens %j as the %s screen", (hash, view) => {
    expect(viewFromHash(hash)).toBe(view);
  });

it("only opens a screen the member's roles allow", () => {
  const agent = ["support_agent"], manager = ["support_manager"], admin = ["tenant_admin", "support_manager"];
  expect(["chat", "tickets", "approvals", "knowledge", "settings"].map(view => [canOpen(view, agent), canOpen(view, manager), canOpen(view, admin)]))
    .toEqual([[true, true, true], [true, true, true], [false, true, true], [false, false, true], [false, false, true]]);
});

it("hides a remembered admin screen from a member who is not an administrator", () => {
  expect(canOpen(viewFromHash("#settings"), ["support_agent"])).toBe(false);
});

it.each([
  [{ status: "draft", publishedVersion: null }, true],
  [{ status: "withdrawn", publishedVersion: null }, true],
  [{ status: "failed", publishedVersion: null }, true],
  [{ status: "failed", publishedVersion: 1 }, false],
  [{ status: "draft", publishedVersion: 1 }, false],
  [{ status: "published", publishedVersion: 1 }, false],
  [{ status: "queued", publishedVersion: null }, false],
  [{ status: "processing", publishedVersion: null }, false],
])("allows deleting %j: %s", async (doc, allowed) => {
  const { canDelete } = await import("../src/documentStatus");
  expect(canDelete(doc)).toBe(allowed);
});
