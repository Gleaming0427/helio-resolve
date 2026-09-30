const currencies: Record<string, Intl.NumberFormat> = {};

export function formatMoney(cents: number, currency: string): string {
  currencies[currency] ??= new Intl.NumberFormat("fr-FR", { style: "currency", currency });
  return currencies[currency].format(cents / 100);
}

/** The number the customer knows (#1001) when the order comes from the store. */
export function orderLabel(orderId: string, reference?: string | null): string {
  return reference ? `Commande ${reference}` : `Commande ${orderId}`;
}
