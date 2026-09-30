import { createHash } from "node:crypto";
import type { OrderSource, PaymentGateway } from "@helio/application";
import {
  type Currency, DomainError, Money, Order, OrderId, type OrderStatus, PaymentId, RefundRejected, TenantId,
} from "@helio/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";
import { secretCipherFromEnv, type SecretCipher } from "./secrets.js";

// 2026-04 makes idempotency keys mandatory on refundCreate: replays return the original refund.
export const SHOPIFY_API_VERSION = "2026-04";
export type ShopifyEndpoint = (shop: string) => string;
// Only *.myshopify.com hosts are called: a tenant cannot point the API at another address.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
export const shopifyEndpoint: ShopifyEndpoint = shop => `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

/** `transient`: retrying later may succeed (network, throttling, outage). */
export class ShopifyError extends Error {
  constructor(message: string, readonly transient: boolean, readonly codes: (string | undefined)[] = []) {
    super(message);
    this.name = "ShopifyError";
  }
}

export class ShopifyClient {
  constructor(readonly shop: string, private readonly token: string, private readonly endpoint: ShopifyEndpoint = shopifyEndpoint) {
    if (!SHOP_DOMAIN.test(shop)) throw new DomainError("Adresse de boutique invalide : indiquez boutique.myshopify.com.");
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint(this.shop), {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": this.token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new ShopifyError("Shopify n’a pas répondu.", true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ShopifyError("Shopify refuse le jeton d’accès : reconnectez la boutique dans Réglages.", false);
    }
    if (response.status === 429 || response.status >= 500) throw new ShopifyError(`Shopify est indisponible (HTTP ${response.status}).`, true);
    if (!response.ok) throw new ShopifyError(`Shopify a refusé la requête (HTTP ${response.status}).`, false);
    const body = await response.json() as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (body.errors?.length) {
      const codes = body.errors.map(error => error.extensions?.code);
      const transient = codes.some(code => code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR");
      throw new ShopifyError(`Shopify : ${body.errors.map(error => error.message).join(" ; ")}`, transient, codes);
    }
    return body.data as T;
  }
}

const REQUIRED_SCOPES = ["read_orders", "write_orders"];

export class ShopifyConnections {
  constructor(
    private readonly db: PrismaClient = prisma,
    private readonly cipher: () => SecretCipher = () => secretCipherFromEnv(),
    private readonly endpoint: ShopifyEndpoint = shopifyEndpoint,
  ) {}

  async status(tenantId: string) {
    const row = await this.db.shopifyConnection.findUnique({ where: { tenantId } });
    return row && { shopDomain: row.shopDomain, connectedAt: row.updatedAt, connectedBy: row.connectedBy };
  }

  /** Checks the token against Shopify before storing it encrypted. */
  async connect(input: { tenantId: string; actorId: string; shopDomain: string; accessToken: string }) {
    const shopDomain = input.shopDomain.trim().toLowerCase();
    const client = new ShopifyClient(shopDomain, input.accessToken, this.endpoint);
    let data: { shop: { name: string; currencyCode: string }; currentAppInstallation: { accessScopes: { handle: string }[] } };
    try {
      data = await client.query(`query HelioConnection { shop { name currencyCode } currentAppInstallation { accessScopes { handle } } }`);
    } catch (error) {
      if (error instanceof ShopifyError) throw new DomainError(`Connexion à Shopify impossible. ${error.message}`);
      throw error;
    }
    const scopes = data.currentAppInstallation.accessScopes.map(scope => scope.handle);
    const missing = REQUIRED_SCOPES.filter(scope => !scopes.includes(scope));
    if (missing.length) throw new DomainError(`Le jeton Shopify doit avoir les accès : ${missing.join(", ")}.`);
    if (!["EUR", "USD"].includes(data.shop.currencyCode)) throw new DomainError(`Devise de la boutique non prise en charge : ${data.shop.currencyCode}.`);
    const tokenCiphertext = await this.cipher().encrypt(input.accessToken, input.tenantId);
    await this.transaction(async tx => {
      await this.assertNoRefundInProgress(tx, input.tenantId, shopDomain);
      await tx.shopifyConnection.upsert({
        where: { tenantId: input.tenantId },
        create: { tenantId: input.tenantId, shopDomain, tokenCiphertext, connectedBy: input.actorId },
        update: { shopDomain, tokenCiphertext, connectedBy: input.actorId },
      });
      await tx.auditEvent.create({ data: { tenantId: input.tenantId, actorId: input.actorId, action: "shopify.connected", resourceType: "shopify_connection", resourceId: shopDomain } });
    });
    return { shopDomain, shopName: data.shop.name };
  }

  async disconnect(tenantId: string, actorId: string) {
    await this.transaction(async tx => {
      await this.assertNoRefundInProgress(tx, tenantId, null);
      const removed = await tx.shopifyConnection.deleteMany({ where: { tenantId } });
      if (removed.count) await tx.auditEvent.create({ data: { tenantId, actorId, action: "shopify.disconnected", resourceType: "shopify_connection" } });
    });
  }

  async client(tenantId: string): Promise<ShopifyClient | null> {
    const row = await this.db.shopifyConnection.findUnique({ where: { tenantId } });
    if (!row) return null;
    return new ShopifyClient(row.shopDomain, await this.cipher().decrypt(row.tokenCiphertext, tenantId), this.endpoint);
  }

  /** A refund with an unknown outcome must be retried on the account where it started. */
  private async assertNoRefundInProgress(tx: Prisma.TransactionClient, tenantId: string, nextShop: string | null) {
    const current = await tx.shopifyConnection.findUnique({ where: { tenantId } });
    if (!current || current.shopDomain === nextShop) return;
    const inProgress = await tx.refundExecution.count({ where: { tenantId, account: `shopify:${current.shopDomain}`, providerRefundId: null, failureReason: null } });
    if (inProgress) throw new DomainError("Des remboursements sont en cours sur la boutique actuelle : terminez-les avant de la changer.");
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.db.$transaction(work, { isolationLevel: "Serializable" }); }
      catch (error) {
        if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) continue;
        throw error;
      }
    }
  }
}

type Money4 = { shopMoney: { amount: string; currencyCode: string } };
type ShopifyOrder = {
  id: string;
  name: string;
  processedAt: string;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: Money4;
  transactions: { id: string; kind: string; status: string; gateway: string; amountSet: Money4 }[];
};
const ORDER_FIELDS = `id name processedAt displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } }
  transactions(first: 20) { id kind status gateway amountSet { shopMoney { amount currencyCode } } }`;

const numericId = (gid: string) => gid.slice(gid.lastIndexOf("/") + 1);
/** Helio ids keep Shopify's numeric id: ord_shp-5123, pay_shp-6123. */
const shopifyGid = (type: string, helioId: string) => {
  const match = /^(?:ord|pay)_shp-(\d{1,20})$/.exec(helioId);
  return match ? `gid://shopify/${type}/${match[1]}` : null;
};
const cents = (amount: string) => Math.round(Number(amount) * 100);

function toOrder(tenantId: TenantId, node: ShopifyOrder): Order {
  const currency = node.currentTotalPriceSet.shopMoney.currencyCode;
  if (currency !== "EUR" && currency !== "USD") throw new DomainError(`Devise non prise en charge : ${currency}.`);
  const payments = node.transactions.filter(transaction => transaction.status === "SUCCESS" && ["SALE", "CAPTURE"].includes(transaction.kind));
  const financial = node.displayFinancialStatus ?? "PENDING";
  const statuses: Record<string, OrderStatus> = { PAID: "paid", REFUNDED: "refunded", PENDING: "pending", AUTHORIZED: "pending" };
  const status = statuses[financial];
  if (!status) throw new DomainError(`La commande ${node.name} est au statut Shopify ${financial} : traitez-la directement dans Shopify.`);
  if (status !== "pending" && payments.length !== 1) {
    throw new DomainError(`La commande ${node.name} a été payée en plusieurs fois : traitez-la directement dans Shopify.`);
  }
  const payment = payments[0];
  return Order.rehydrate({
    id: OrderId.of(`ord_shp-${numericId(node.id)}`),
    tenantId,
    status,
    total: Money.ofCents(cents(node.currentTotalPriceSet.shopMoney.amount), currency as Currency),
    paymentId: status === "pending" || !payment ? null : PaymentId.of(`pay_shp-${numericId(payment.id)}`),
    paidAt: status === "pending" ? null : new Date(node.processedAt),
    reference: node.name,
  });
}

export class ShopifyOrderSource implements OrderSource {
  constructor(private readonly connections: ShopifyConnections) {}

  async find(tenantId: TenantId, reference: string) {
    const client = await this.connections.client(tenantId.toString());
    if (!client) return { connected: false as const };
    try {
      const node = await this.lookup(client, reference.trim());
      return { connected: true as const, order: node ? toOrder(tenantId, node) : null };
    } catch (error) {
      if (error instanceof ShopifyError) throw new DomainError(`Lecture de la commande impossible. ${error.message}`);
      throw error;
    }
  }

  private async lookup(client: ShopifyClient, reference: string): Promise<ShopifyOrder | null> {
    const id = shopifyGid("Order", reference);
    if (id) return (await client.query<{ order: ShopifyOrder | null }>(`query HelioOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id })).order;
    // The order name customers see, e.g. #1001 (shops can add a prefix or suffix).
    const name = /^#?([A-Za-z0-9-]{1,30})$/.exec(reference)?.[1];
    if (!name) throw new DomainError("Référence de commande invalide : indiquez son numéro, par exemple #1001.");
    const data = await client.query<{ orders: { nodes: ShopifyOrder[] } }>(
      `query HelioOrderByName($query: String!) { orders(first: 1, query: $query) { nodes { ${ORDER_FIELDS} } } }`, { query: `name:#${name}` });
    return data.orders.nodes[0] ?? null;
  }
}

/** Shopify recommends UUID keys: derive a stable one from Helio's persisted key. */
export function idempotencyUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const refundNote = (idempotencyKey: string) => `Helio ${idempotencyKey}`;

async function refundOnShopify(client: ShopifyClient, input: Parameters<PaymentGateway["refund"]>[0]) {
  const orderId = shopifyGid("Order", input.orderId.toString());
  const paymentId = shopifyGid("OrderTransaction", input.paymentId.toString());
  if (!orderId || !paymentId) throw new RefundRejected("Cette commande n’est pas liée à Shopify.");
  const note = refundNote(input.idempotencyKey);
  try {
    const existing = await client.query<{ order: { refunds: { id: string; note: string | null }[]; transactions: { id: string; gateway: string }[] } | null }>(
      `query HelioRefunds($id: ID!) { order(id: $id) { refunds(first: 50) { id note } transactions(first: 20) { id gateway } } }`, { id: orderId });
    if (!existing.order) throw new RefundRejected("La commande n’existe plus dans Shopify.");
    // Shopify keeps idempotency keys for a limited time; the note still proves an earlier refund.
    const previous = existing.order.refunds.find(refund => refund.note === note);
    if (previous) return { providerRefundId: previous.id };
    const payment = existing.order.transactions.find(transaction => transaction.id === paymentId);
    if (!payment) throw new RefundRejected("Le paiement d’origine est introuvable dans Shopify.");
    const result = await client.query<{ refundCreate: { refund: { id: string } | null; userErrors: { message: string }[] } }>(
      `mutation HelioRefund($input: RefundInput!) { refundCreate(input: $input) @idempotent(key: "${idempotencyUuid(input.idempotencyKey)}") { refund { id } userErrors { field message } } }`,
      { input: { orderId, note, notify: false, transactions: [{ orderId, parentId: paymentId, kind: "REFUND", gateway: payment.gateway, amount: (input.amount.cents / 100).toFixed(2) }] } });
    if (result.refundCreate.userErrors.length) {
      throw new RefundRejected(`Shopify a refusé le remboursement : ${result.refundCreate.userErrors.map(error => error.message).join(" ; ")}`);
    }
    if (!result.refundCreate.refund) throw new ShopifyError("Shopify n’a renvoyé aucun remboursement.", true);
    return { providerRefundId: result.refundCreate.refund.id };
  } catch (error) {
    if (!(error instanceof ShopifyError)) throw error;
    if (error.codes.includes("IDEMPOTENCY_KEY_PARAMETER_MISMATCH")) {
      throw new RefundRejected("Shopify a déjà reçu cette demande avec d’autres paramètres : vérifiez le remboursement dans Shopify.");
    }
    // Outcome unknown: the intent stays pending and is retried with the same key.
    throw new DomainError(`${error.message} Le remboursement reste en attente : relancez l’exécution, sans risque de doublon.`);
  }
}

/** Refunds through the tenant's connected store. Without one, the simulated provider is
 * only available outside production (demo data). */
export class ConnectedPaymentGateway implements PaymentGateway {
  constructor(
    private readonly connections: ShopifyConnections,
    private readonly simulated: PaymentGateway | null,
  ) {}

  async account(tenantId: TenantId) {
    const connection = await this.connections.status(tenantId.toString());
    if (connection) return `shopify:${connection.shopDomain}`;
    if (this.simulated) return this.simulated.account(tenantId);
    throw new DomainError("Aucune boutique connectée : connectez Shopify dans Réglages pour exécuter un remboursement.");
  }

  async refund(input: Parameters<PaymentGateway["refund"]>[0]) {
    if (!input.account.startsWith("shopify:")) {
      if (!this.simulated) throw new RefundRejected("Cette demande visait le prestataire de démonstration, indisponible ici.");
      return this.simulated.refund(input);
    }
    const client = await this.connections.client(input.tenantId.toString());
    if (!client || `shopify:${client.shop}` !== input.account) {
      throw new RefundRejected("La boutique connectée a changé depuis la demande : traitez ce remboursement directement dans Shopify.");
    }
    return refundOnShopify(client, input);
  }
}
