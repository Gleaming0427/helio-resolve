# Transactions et reprise des remboursements

## Écritures locales

`UnitOfWork` est un port de la couche application. `PrismaUnitOfWork` fournit
aux repositories et à l'audit le même client transactionnel Prisma. Les transactions
utilisent l'isolation `Serializable` ; les conflits de sérialisation/deadlocks
(`P2034`) et de création concurrente (`P2002`) sont retentés jusqu'à cinq tentatives.
Les callbacks ne doivent contenir aucun appel à un service externe.

Les opérations suivantes sont atomiques :

- Création d'un ticket et de son audit.
- Proposition : passage de la commande à `refund_pending`, approbation et audit.
- Approbation par le manager et audit.
- Finalisation : commande `refunded`, approbation `executed`, référence prestataire
  persistée dans `RefundExecution` et audit `refund.executed`.

## Paiement externe

Une transaction SQL ne peut pas annuler un paiement distant. L'exécution utilise
un journal durable :

1. Après validation de l'approbation et de la commande, enregistrer `RefundExecution`
   dans une transaction, avec tenant, commande, paiement, acteur et clé stable.
2. Appeler le prestataire **hors transaction**, avec cette clé persistée.
3. Finaliser les écritures locales dans une autre transaction.

`providerRefundId = null` signifie « à reprendre / résultat externe inconnu ».
Ce n'est pas une preuve d'échec du paiement. Après un timeout, un crash du processus
ou un échec de finalisation, on reprend avec le même paiement et la même clé.
Une exécution déjà finalisée renvoie son résultat sauvegardé sans nouvel appel
prestataire. L'acteur de l'exécution initiale est conservé dans l'audit.

La contrainte unique `(tenantId, orderId)` empêche deux intentions de remboursement
pour une commande. Les transactions sérialisables empêchent les propositions
concurrentes et les doubles finalisations locales. Des appels prestataire peuvent
être concurrents : leur déduplication relève du contrat `PaymentGateway`.

**Prestataire :** Shopify (`ConnectedPaymentGateway`, partagé par l'API et la reprise
dans `apps/api/src/payments.ts`). `refundCreate` reçoit une clé d'idempotence dérivée
de la clé persistée ; Shopify renvoie le remboursement d'origine pour un rejeu. Passé
le délai de conservation des clés, Helio retrouve un remboursement antérieur par sa
note `Helio <clé>` avant tout nouvel appel. L'intention enregistre le compte
(`shopify:<boutique>`) et le montant : un rejeu n'utilise jamais une autre boutique,
et la boutique ne peut pas être changée tant qu'un remboursement est en cours.
Un refus définitif (`RefundRejected`) est enregistré dans `failureReason` : l'intention
n'est plus reprise et doit être traitée dans Shopify. Sans boutique connectée, le
prestataire simulé (`FakePaymentGateway`, aucun transfert) ne sert qu'en dehors de la
production. Voir [shopify-pilot.md](shopify-pilot.md).

## Installation de la migration

Depuis la racine, avec `DATABASE_URL` défini pour la base cible (la CLI Prisma lit
également le `.env` de son workspace) :

```bash
npm install
npm run db:generate
npm exec -w @helio/adapters -- prisma migrate deploy
npm run build
```

La migration `0002_refund_execution` ajoute une table ; elle ne modifie pas les
commandes existantes. Elle a été vérifiée sur une base de test isolée, pas appliquée
à la base de développement ou de production par cette modification.

Avant déploiement, interrompre les anciennes instances et réconcilier les éventuels
paiements déjà envoyés par l'ancienne version : ils n'ont pas de journal durable,
et leurs anciennes clés d'idempotence ne permettent pas une reprise automatique
sûre avec le nouveau format. Ne pas fabriquer de nouvelles intentions pour les
anciens paiements dont le résultat est inconnu.

## Reprise

Un nouvel appel à `POST /approvals/:id/execute` reprend la même intention.
Pour un opérateur disposant de l'accès à la base et au prestataire :

```bash
npm run refunds:resume
# Limiter le lot (100 par défaut, 1000 maximum)
npm run refunds:resume -- 50
```

La commande charge le `.env` racine et utilise le même adaptateur de paiement
que l'API. Elle ne sélectionne que les intentions persistées non finalisées :
elle n'exécute jamais une approbation simplement approuvée sans demande d'exécution.
Chaque résultat affiche le tenant, l'approbation et `recovered`. Code de sortie 1
si au moins une reprise échoue ; les intentions correspondantes restent en base.
Les succès d'un lot sont conservés même si une autre reprise échoue.

Cette commande est une reprise manuelle, pas un worker automatiquement planifié.
Relancer pour les lots suivants. Les échecs persistants doivent être investigués
avant de relancer indéfiniment les mêmes premières intentions. Ne jamais supprimer
une intention ou changer sa clé pour contourner un timeout.

## Vérification

```bash
npm run typecheck
npm test
```

Les tests PostgreSQL exigent une base dédiée nommée `helio_refund_test`, migrée
avec toutes les migrations (`DATABASE_URL=<url de test> npm run db:deploy`). Ils effacent
ses données métier : ne pas utiliser une base partagée. La CI GitHub
(`.github/workflows/ci.yml`) les exécute à chaque push et pull request. En local,
fournir son URL uniquement pour ces tests :

```bash
HELIO_TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/helio_refund_test npm run test:integration
```

Les tests vérifient les rollbacks, l'isolation des tenants, les propositions et
exécutions concurrentes, les réponses prestataire perdues, les échecs après paiement
et la reprise. PostgreSQL est réel ; le prestataire de paiement est une simulation
idempotente. Aucun paiement réel ni appel AWS n'est effectué.

