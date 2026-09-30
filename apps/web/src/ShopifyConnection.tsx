import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";

/** The access token is write-only: once saved it is never shown again, only the shop. */
export function ShopifyConnection() {
  const cache = useQueryClient();
  const status = useQuery({ queryKey: ["shopify"], queryFn: api.shopify });
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [notice, setNotice] = useState("");
  const connect = useMutation({ mutationFn: api.connectShopify, onSuccess: async result => {
    setAccessToken(""); setNotice(`Boutique « ${result.shopName} » connectée. L’assistant lit désormais ses commandes.`);
    await cache.invalidateQueries({ queryKey: ["shopify"] });
  } });
  const disconnect = useMutation({ mutationFn: api.disconnectShopify, onSuccess: async () => {
    setNotice("Boutique déconnectée."); await cache.invalidateQueries({ queryKey: ["shopify"] });
  } });
  const connection = status.data?.connection;
  return <>
    <h3>Boutique Shopify</h3>
    {status.error && <p role="alert">{status.error.message}</p>}
    {connection
      ? <div className="documentRow"><span><b>{connection.shopDomain}</b><small>Connectée le {new Date(connection.connectedAt).toLocaleString()}</small></span>
          <button disabled={disconnect.isPending} onClick={() => { if (confirm("Déconnecter la boutique ? L’assistant ne pourra plus lire les commandes ni rembourser.")) disconnect.mutate(); }}>Déconnecter</button></div>
      : status.data && <p className="fieldHelp">Aucune boutique connectée : l’assistant ne peut pas lire vos commandes ni rembourser.</p>}
    <p className="fieldHelp">Dans Shopify : Paramètres › Applications › Développer des applications. Créez une application avec les accès <code>read_orders</code> et <code>write_orders</code>, installez-la puis copiez le jeton d’accès Admin API.</p>
    <form onSubmit={event => { event.preventDefault(); setNotice(""); connect.mutate({ shopDomain: shopDomain.trim(), accessToken: accessToken.trim() }); }}>
      <label htmlFor="shop-domain">Adresse de la boutique</label>
      <input id="shop-domain" required placeholder="ma-boutique.myshopify.com" pattern="[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com" value={shopDomain} onChange={e => setShopDomain(e.target.value)} />
      <label htmlFor="shop-token">Jeton d’accès Admin API</label>
      <input id="shop-token" type="password" required autoComplete="off" placeholder="shpat_…" value={accessToken} onChange={e => setAccessToken(e.target.value)} />
      <button disabled={connect.isPending}>{connect.isPending ? "Vérification auprès de Shopify…" : connection ? "Remplacer la connexion" : "Connecter la boutique"}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    {[connect.error, disconnect.error].filter(Boolean).map((error, i) => <p role="alert" key={i}>{error?.message}</p>)}
  </>;
}
