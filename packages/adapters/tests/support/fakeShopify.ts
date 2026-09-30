import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A Shopify Admin GraphQL double with the behaviours refunds depend on:
 * idempotency keys (replay returns the original result, other parameters are refused),
 * key expiry, lost responses after commit, and definitive refusals. */
export type FakeOrder = {
  number: number;
  name: string;
  processedAt: string;
  financial: string;
  amount: string;
  currency: string;
  paymentId: number;
  refunds: { id: string; note: string | null; amount: string }[];
};

export class FakeShopify {
  readonly token = `shpat_${"f".repeat(32)}`;
  scopes = ["read_orders", "write_orders"];
  orders = new Map<number, FakeOrder>();
  refundCreateCalls = 0;
  private keys = new Map<string, { params: string; result: unknown }>();
  private loseNextResponse = false;
  private refusal: string | null = null;
  private server?: Server;
  private port = 0;

  endpoint = () => `http://127.0.0.1:${this.port}/admin/api/graphql.json`;

  addOrder(order: Partial<FakeOrder> & { number: number }) {
    this.orders.set(order.number, {
      name: `#${order.number}`, processedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), financial: "PAID",
      amount: "25.00", currency: "EUR", paymentId: order.number + 5000, refunds: [], ...order,
    });
  }
  loseNextRefundResponse() { this.loseNextResponse = true; }
  refuseNextRefund(message: string) { this.refusal = message; }
  /** Shopify keeps idempotency keys for a limited time. */
  forgetKeys() { this.keys.clear(); }
  reset() {
    this.orders.clear(); this.keys.clear(); this.refundCreateCalls = 0;
    this.loseNextResponse = false; this.refusal = null; this.scopes = ["read_orders", "write_orders"];
  }

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        if (request.headers["x-shopify-access-token"] !== this.token) {
          response.writeHead(401).end(JSON.stringify({ errors: "Invalid API key or access token" }));
          return;
        }
        const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
        const { data, lose } = this.handle(query, variables);
        if (lose) { response.destroy(); return; }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
      });
    });
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }
  async stop() { await new Promise(resolve => this.server?.close(resolve)); }

  private view(order: FakeOrder) {
    const money = (amount: string) => ({ shopMoney: { amount, currencyCode: order.currency } });
    return {
      id: `gid://shopify/Order/${order.number}`, name: order.name, processedAt: order.processedAt,
      displayFinancialStatus: order.financial, currentTotalPriceSet: money(order.amount),
      transactions: [{ id: `gid://shopify/OrderTransaction/${order.paymentId}`, kind: "SALE", status: "SUCCESS", gateway: "bogus", amountSet: money(order.amount) }],
    };
  }
  private order(gid: unknown) {
    return this.orders.get(Number(String(gid).split("/").pop()));
  }

  private handle(query: string, variables: Record<string, unknown>): { data: unknown; lose?: boolean } {
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    switch (operation) {
      case "HelioConnection":
        return { data: { data: { shop: { name: "Helio Test", currencyCode: "EUR" }, currentAppInstallation: { accessScopes: this.scopes.map(handle => ({ handle })) } } } };
      case "HelioOrder": {
        const order = this.order(variables.id);
        return { data: { data: { order: order ? this.view(order) : null } } };
      }
      case "HelioOrderByName": {
        const name = String(variables.query).replace(/^name:/, "");
        const order = [...this.orders.values()].find(candidate => candidate.name === name);
        return { data: { data: { orders: { nodes: order ? [this.view(order)] : [] } } } };
      }
      case "HelioRefunds": {
        const order = this.order(variables.id);
        return { data: { data: { order: order && {
          refunds: order.refunds.map(({ id, note }) => ({ id, note })),
          transactions: [{ id: `gid://shopify/OrderTransaction/${order.paymentId}`, gateway: "bogus" }],
        } } } };
      }
      case "HelioRefund":
        return this.refundCreate(query, variables);
      default:
        return { data: { errors: [{ message: `Unknown operation ${operation}` }] } };
    }
  }

  private refundCreate(query: string, variables: Record<string, unknown>) {
    this.refundCreateCalls++;
    // Mandatory from API version 2026-04.
    const key = /@idempotent\(key: "([^"]+)"\)/.exec(query)?.[1];
    if (!key) return { data: { errors: [{ message: "An idempotency key is required", extensions: { code: "BAD_REQUEST" } }] } };
    const params = JSON.stringify(variables.input);
    const seen = this.keys.get(key);
    if (seen) {
      if (seen.params !== params) return { data: { errors: [{ message: "Idempotency key reused with different parameters", extensions: { code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" } }] } };
      return { data: seen.result };
    }
    const input = variables.input as { orderId: string; note: string; transactions: { parentId: string; amount: string }[] };
    const order = this.order(input.orderId);
    let result: unknown;
    if (this.refusal || !order || input.transactions[0]!.parentId !== `gid://shopify/OrderTransaction/${order.paymentId}`) {
      result = { data: { refundCreate: { refund: null, userErrors: [{ field: ["transactions"], message: this.refusal ?? "Invalid transaction" }] } } };
      this.refusal = null;
    } else {
      const id = `gid://shopify/Refund/${9000 + order.refunds.length + [...this.orders.values()].reduce((n, o) => n + o.refunds.length, 0)}`;
      order.refunds.push({ id, note: input.note, amount: input.transactions[0]!.amount });
      if (input.transactions[0]!.amount === order.amount) order.financial = "REFUNDED";
      result = { data: { refundCreate: { refund: { id }, userErrors: [] } } };
    }
    this.keys.set(key, { params, result });
    const lose = this.loseNextResponse;
    this.loseNextResponse = false;
    return { data: result, lose };
  }
}
