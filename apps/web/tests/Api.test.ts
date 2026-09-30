import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/auth", () => ({ auth: { token: async () => "test-token" } }));
import { api } from "../src/api";

afterEach(() => { vi.unstubAllGlobals(); });

it.each([500, 502, 503])("gives a support reference for an unexpected HTTP %s without raw backend details", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status,
    json: async () => ({ error: "internal_error", message: "secret-password", requestId: "req-123" }) }));
  await expect(api.approve("apr_TEST123")).rejects.toThrow("Le service a rencontré un problème. Réessayez dans quelques instants. Référence : req-123.");
  await expect(api.approve("apr_TEST123")).rejects.not.toThrow("secret-password");
});

it.each([
  [401, "Votre session n’est pas valide. Reconnectez-vous."],
  [403, "Vous n’avez pas les droits nécessaires pour cette action."],
  [409, "Cette action n’est pas possible dans l’état actuel. Rechargez les informations."],
  [429, "Trop de demandes. Patientez une minute avant de réessayer."],
])("explains an expected HTTP %s without a technical reference", async (status, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, headers: new Headers({ "x-request-id": "req-header" }),
    json: async () => ({ error: "internal_error", message: "secret-password", requestId: "req-123" }) }));
  const error = await api.approve("apr_TEST123").catch((caught: Error) => caught);
  expect(error.message).toBe(message);
});

it.each(["approve", "execute"] as const)("sends %s without an empty JSON content type", async (action) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  await api[action]("apr_TEST123");
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toContain(`/approvals/apr_TEST123/${action}`);
  expect(init.method).toBe("POST");
  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).has("content-type")).toBe(false);
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
});

it("still sends chat messages as JSON", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  await api.chat({ message: "Bonjour" });
  const [, init] = fetchMock.mock.calls[0]!;
  expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(init.body)).toEqual({ message: "Bonjour" });
});

it("falls back to the response header for the support reference", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers({ "x-request-id": "req-header" }),
    json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  await expect(api.workspace()).rejects.toThrow("Référence : req-header.");
});

it("explains network failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  await expect(api.workspace()).rejects.toThrow("Impossible de joindre Helio");
});

it("shows the business message of any domain refusal", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409,
    json: async () => ({ error: "ApprovalError", message: "Vous avez fait cette proposition : une autre personne doit l’approuver." }) }));
  await expect(api.approve("apr_TEST123")).rejects.toThrow("une autre personne doit l’approuver");
});

it("shows safe domain conflict explanations", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, headers: new Headers({ "x-request-id": "req-header" }),
    json: async () => ({ error: "DomainError", message: "Conservez au moins un administrateur actif." }) }));
  const error = await api.workspace().catch((caught: Error) => caught);
  expect(error.message).toBe("Conservez au moins un administrateur actif.");
});
