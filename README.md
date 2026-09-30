# Helio Resolve
Helio Resolve is a B2B agentic customer support application. The LLM orchestrates tools, but the domain and
use cases remain the authority. A refund is first proposed, then approved and executed explicitly by an
authorized human.

## What the MVP contains
- React + Vite for the support console.
- Fastify 5 for the API.
- Isolated TypeScript domain: Order, Ticket, Approval, Money, and IDs.
- PostgreSQL + Prisma for relational data.
- pgvector for semantic search.
- Amazon Bedrock Converse for the agent loop and tool use.
- Amazon Titan Embeddings for RAG indexing.
- Versioned document library with a durable PostgreSQL queue and an indexing worker.
- Shopify connector (Admin GraphQL API 2026-04): orders read from the store, refunds with idempotency keys.
- Chat memory per conversation, tickets linked to orders.
- Cognito for OIDC/PKCE in production.
- Four-eyes human approval before refund execution, with durable, replayable refund intents.
- Application-level audit of sensitive actions.
- CDK for VPC, RDS, ECS/Fargate, ALB (HTTPS), WAF, S3, KMS, Cognito, CloudFront and CloudWatch alarms.

## Local startup of the core app and database
```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:migrate
npm run build:packages
npm run db:seed
npm test
npm run typecheck
```
The seed creates the demo workspace `ten_DEMO123` (administrator `usr_DEMO123`, agent `usr_DEMOAGENT`)
and a new paid order `ord_DEMO-…` on each run, printed in the terminal.

PostgreSQL integration tests need a dedicated database named `helio_refund_test` (its data is cleared);
the GitHub CI (`.github/workflows/ci.yml`) runs them on every push and pull request:
```bash
DATABASE_URL=postgresql://helio:helio@localhost:5432/helio_refund_test npm run db:deploy
HELIO_TEST_DATABASE_URL=postgresql://helio:helio@localhost:5432/helio_refund_test npm run test:integration
```

## Local authentication
`.env.example` runs without Cognito:
```env
NODE_ENV=development
AUTH_MODE=dev
VITE_AUTH_MODE=dev
DEV_TENANT_ID=ten_DEMO123
DEV_USER_ID=usr_DEMO123
DEV_ROLES=support_manager,tenant_admin
```
The bypass is explicitly disabled when `NODE_ENV=production`. In dev mode, the header selector
« agir en tant que » switches between the demo administrator and the demo agent; memberships in PostgreSQL
still decide tenant and roles.

## Start the API and frontend
Terminal 1:
```bash
npm run dev-api
```
Terminal 2:
```bash
npm run dev-web
```
Then open `http://localhost:5173`.

## Using Bedrock and RAG
Real chat requires AWS credentials and access to the configured models in:
```env
AWS_REGION=eu-west-3
BEDROCK_MODEL_ID=eu.amazon.nova-pro-v1:0
BEDROCK_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0
```
In a third terminal, run `npm run dev-worker`. The API saves drafts and publication requests in PostgreSQL.
The worker claims a task, generates embeddings and publishes the entire version atomically. An interrupted
task can be reclaimed after five minutes. Failed tasks can be retried from the document library.
The worker writes one JSON line per task (`document_indexed`, `document_indexing_superseded`,
`document_indexing_failed` with its cause) and stores a failure code: `embedding_failed` (Bedrock) or
`storage_failed` (PostgreSQL). The library warns when a document stays queued for more than two minutes
or its lease expires, which means no worker is running. In AWS, two alarms notify the `AlarmTopicArn` SNS
topic: worker errors, and no running worker task. Set `ALARM_EMAIL` before `cdk deploy` to subscribe an
address (confirm the subscription email).
The former S3/SQS ingestion path has been removed. The CDK stack deletes its queues and keeps the old
knowledge bucket for its data, with no access granted to the API or the worker.

## Lot 2 — administration et documents

Appliquer les migrations existantes et régénérer le client avant de relancer l’application :

```bash
npm run db:deploy
npm run db:generate
npm run build:packages
```

- **Réglages** : nom de l’entreprise, langue, ton et plafond de remboursement des managers en euros.
  Chaque sauvegarde conserve une révision. « Reprendre ces valeurs » recharge une ancienne version dans
  le formulaire ; enregistrer crée une nouvelle révision. Une modification concurrente est refusée.
  La langue et le ton sont transmis à l’assistant dès la prochaine demande. Le plafond s’applique à
  l’approbation et à l’exécution ; au-delà, ou pour une autre devise, un administrateur est nécessaire.
- **Membres** : liens d’invitation à transmettre en privé, valables sept jours et à usage unique.
  Aucun email n’est envoyé par Helio. Le destinataire se connecte puis accepte le lien. Un compte est
  rattaché à un seul espace. Les rôles et suspensions en base priment sur les anciens groupes du jeton.
  Le dernier administrateur actif ne peut pas être suspendu ou rétrogradé.
  Chaque membre apparaît avec l’email vérifié par Cognito : à la connexion, le front envoie son ID token,
  dont l’API contrôle la signature, l’application, l’utilisateur et `email_verified`. En mode dev, sans
  Cognito, la liste affiche « Email pas encore vérifié » et l’identifiant.
- **Documents** : créer un brouillon, publier, suivre l’indexation, consulter les versions, modifier,
  retirer et supprimer. Le chat consulte uniquement les versions publiées de l’entreprise connectée et ne
  cite que les documents sur lesquels sa réponse s’appuie. Pendant la modification ou en cas d’échec de la
  nouvelle indexation, la version publiée précédente reste disponible. Le retrait exclut le document des
  prochaines recherches ; les réponses déjà affichées ne sont pas effacées. Seul un document que le chat
  ne peut plus utiliser (brouillon jamais publié, retiré ou en échec) peut être supprimé, avec ses versions.

La migration `0004_workspace_lifecycle` remet les anciens documents gérés en brouillon : republiez-les
depuis la bibliothèque. La migration `0005_import_legacy_knowledge` conserve l’ancien index sans identifiant
de document : elle regroupe ses fragments par entreprise et titre dans des documents publiés importés.
L’ancien index ne conservait pas l’ordre des paragraphes : relisez les fragments importés avant une édition.
Les titres identiques d’une même entreprise sont regroupés, sans suppression de leurs fragments.

Validation manuelle : modifier les réglages, recharger la page, vérifier l’historique ; créer une procédure,
publier, attendre « Publié » puis poser une question dans le chat ; retirer et refaire une recherche.
En mode dev, seuls les deux membres de démo sont disponibles et l’email vérifié n’existe pas. Utilisez
deux comptes Cognito pour valider l’invitation et l’affichage des emails en conditions réelles.

## Lot 3 — intégration métier (Shopify)

```bash
npm run db:deploy && npm run db:generate && npm run build:packages
npm run db:seed   # espace de démo, conseiller de démo et nouvelle commande payée
```

La migration `0007_business_integration` retrouve l’auteur des propositions existantes dans l’audit et
rattache les intentions de remboursement existantes au prestataire simulé.

- **Connecteur Shopify** (Réglages, administrateur) : commandes lues dans la boutique (`#1001`),
  remboursements exécutés par `refundCreate` avec clé d’idempotence. Jeton chiffré (KMS en AWS,
  `LOCAL_SECRET_KEY` en local). Détails, reprises et boutique de test : [docs/shopify-pilot.md](docs/shopify-pilot.md).
- **Mémoire de conversation** : chaque conversation est enregistrée et privée à son auteur ; l’assistant
  reçoit les 20 derniers messages. « Conversations récentes » permet de reprendre un échange.
- **Tickets** : créés par l’assistant (liés à la commande), listés dans Tickets, marqués résolus.
- **Remboursement contrôlé** : l’auteur d’une proposition ne peut pas l’approuver ; un manager peut la
  refuser (la commande redevient remboursable) ; les approbations en attente sont listées ; un refus
  définitif de la boutique est enregistré et n’est jamais repris.
- Sans boutique connectée, la démo locale utilise le prestataire simulé (jamais en production).
  En mode dev, « agir en tant que » bascule entre l’administrateur et le conseiller de démo pour
  tester l’approbation à quatre yeux.

Parcours de validation : en conseiller, demander au chat un remboursement pour la commande affichée par
`db:seed` ; passer en administrateur, ouvrir la proposition depuis Approbations, l’approuver puis
l’exécuter ; relancer l’exécution (même référence, aucun doublon).

## Cognito in production
The frontend uses Authorization Code + PKCE. The API expects a valid Cognito access token. To bootstrap
the first administrator, assign `tenant_admin` and exactly one `tenant__<TenantId>` group (for example
`tenant__ten_ACME123`) to a trusted Cognito identity. Bootstrap only works when the workspace has no members.
Thereafter, PostgreSQL membership determines tenant and permissions; invitation recipients need no Cognito
groups. `support_agent` uses the chat and tickets, `support_manager` also approves, rejects and executes
refunds within the configured ceiling, and `tenant_admin` manages the workspace, members, documents, the
Shopify connection and all refunds. Nobody can approve a refund proposal they made.
The CDK enables self-registration with email verification so invitees can create their identity themselves.
Registration alone grants no workspace access. Existing deployments need this CDK update before new
colleagues can register; otherwise their identities must already exist in Cognito.
The tenant is never accepted from the request body.

## Errors and support references
Every response carries an `x-request-id` (a UUID, unique across instances). The UI shows it as
« Référence » for unexpected errors (5xx, unreadable responses); expected refusals show their business
message only. Search the API logs for `reqId` to find the request. Internal errors are
logged at `error` level with their type, code, message and stack, credentials in URLs and bearer tokens
scrubbed; responses never include them. Rejected client requests (400, 403, 409, 429…) are logged at `info`.

## Quotas
Chat (20/min) and document creation/publication (10/min) are limited per tenant with a PostgreSQL counter
(migration `0006_quota_window`), shared by all API instances. The 120 requests/min limit per client IP is a
per-instance guard; the WAF IP rule is the shared limit. Behind the ALB, `TRUST_PROXY_HOPS=1` makes the API
use the client address appended by the ALB; leave it empty when the API is reached directly.

## AWS deployment
The API is served over HTTPS only: the ALB has a single 443 listener (TLS 1.2+) and no port 80, since a
bearer token sent over HTTP would already have leaked. Before `cdk deploy`, request an ACM certificate for the
API host name in the stack region, then:
```bash
export API_DOMAIN_NAME=api.example.com
export API_CERTIFICATE_ARN=arn:aws:acm:eu-west-3:123456789012:certificate/...
```
Synthesis fails without them. After deployment, point `API_DOMAIN_NAME` to the `ApiLoadBalancerDnsName` output
(CNAME or Route 53 alias).
Build the frontend with `VITE_API_URL=https://<API_DOMAIN_NAME>`; a build targeting `http://` fails, except
for `localhost`. Then sync `apps/web/dist` to the web bucket created by CDK. For the API and worker,
`ContainerImage.fromAsset()` builds the Dockerfiles and pushes the images to an ECR repository managed by the
CDK assets.
The stack creates a KMS key (with rotation) for tenant store credentials and passes it to the API as
`SECRET_KMS_KEY_ID`; only the API task role can use it. An operator running `npm run refunds:resume` for a
Shopify tenant needs database access and `kms:Decrypt` on this key.
Before a real production rollout, add a secret rotation strategy for the database, API alarms (5xx, latency),
CloudTrail, GuardDuty Runtime Monitoring, a retention policy for chat conversations (they contain customer
data), and agentic evaluation tests.
