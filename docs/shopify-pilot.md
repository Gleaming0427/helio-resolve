# Pilote Shopify

Helio lit les commandes et exécute les remboursements dans la boutique Shopify de chaque
entreprise, via l’API Admin GraphQL **2026-04**. Depuis cette version, `refundCreate` exige
une clé d’idempotence : un rejeu avec la même clé renvoie le remboursement d’origine, et la
même clé avec d’autres paramètres est refusée (`IDEMPOTENCY_KEY_PARAMETER_MISMATCH`).

## Parcours

1. **Connexion** (administrateur, Réglages › Boutique Shopify) : adresse `boutique.myshopify.com`
   et jeton Admin API. Helio vérifie le jeton et les accès `read_orders` / `write_orders` auprès
   de Shopify, puis le chiffre (KMS en AWS, contexte = entreprise). Le jeton n’est jamais réaffiché.
2. **Commande** : dans le chat, `#1001` est lu dans Shopify et copié dans Helio (`ord_shp-<id>`),
   avec son numéro, son montant et son paiement. Tant qu’aucun remboursement n’est en cours,
   chaque lecture rafraîchit la copie (y compris un remboursement fait directement dans Shopify).
   Statuts pris en charge : payée, remboursée, en attente. Les commandes partiellement remboursées
   ou payées en plusieurs fois sont à traiter dans Shopify.
3. **Proposition** : l’assistant (ou un conseiller) propose un remboursement total, dans les 30 jours.
4. **Approbation** : par un manager (dans son plafond) ou un administrateur, **autre que l’auteur**.
   Une proposition refusée remet la commande « payée » : une nouvelle demande est possible.
5. **Exécution** : l’intention est enregistrée avec le compte (`shopify:<boutique>`), le montant et
   une clé stable, puis `refundCreate` est appelé hors transaction avec la note `Helio <clé>`.

## Reprises et absence de double exécution

| Situation | Comportement |
| --- | --- |
| Réponse perdue, timeout, Shopify indisponible | Intention en attente. Relancer l’exécution (ou `npm run refunds:resume`) : même clé, même compte. |
| Clé expirée côté Shopify | Avant tout appel, Helio cherche un remboursement portant la note `Helio <clé>` sur la commande. |
| Exécutions simultanées | Une seule intention (clé unique en base) ; Shopify déduplique les appels par clé. |
| Refus définitif (`userErrors`, paramètres différents) | Intention marquée en échec, jamais reprise. À traiter dans Shopify. |
| Changement ou déconnexion de boutique | Refusé tant qu’un remboursement est en cours. |
| Jeton révoqué | Erreur non définitive : reconnecter la boutique puis relancer. |

## Boutique de développement

1. Créer un compte Shopify Partner, puis une **boutique de développement**.
2. Paramètres › Paiements : activer la passerelle de test **(for testing) Bogus Gateway**.
3. Créer une commande test payée avec la carte `1` (Bogus Gateway).
4. Paramètres › Applications › Développer des applications : créer une application, accès Admin API
   `read_orders` et `write_orders`, l’installer, copier le jeton `shpat_…`.
5. En local, définir `LOCAL_SECRET_KEY` (32 octets en base64, par exemple `openssl rand -base64 32`)
   dans `.env`, puis connecter la boutique depuis Réglages.

Vérifications contre la vraie boutique (lecture seule par défaut) :

```bash
SHOPIFY_TEST_SHOP=ma-boutique.myshopify.com SHOPIFY_TEST_TOKEN=shpat_… SHOPIFY_TEST_ORDER=#1001 \
  npx vitest run --config vitest.integration.config.ts packages/adapters/tests/ShopifyLive.integration.test.ts
```

Ajouter `SHOPIFY_TEST_REFUND=yes` pour rembourser la commande test (Bogus Gateway, aucun argent réel)
et vérifier qu’un rejeu renvoie le même remboursement. Utiliser une nouvelle commande test à chaque fois.

Sans boutique, `tests/support/fakeShopify.ts` reproduit ces comportements (clé d’idempotence,
réponse perdue, clé expirée, refus) : `ShopifyJourney.integration.test.ts` déroule le parcours
complet sur PostgreSQL à chaque exécution de la CI.
