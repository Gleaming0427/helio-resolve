# Helio Resolve

**Customer support, from the first question to the resolved request.**

Helio gives support teams one place to consult company procedures, look up orders, create tickets, and handle refunds. An AI assistant helps with the request; business rules and human approval govern the actions it can take.

Built as a multi-tenant B2B application with a local demo, a Shopify integration, and AWS infrastructure defined in code.

[Quick start](#quick-start) · [Try the demo](#try-the-demo) · [Architecture](#architecture) · [Testing](#testing) · [AWS deployment](docs/operations.md#aws-deployment)

## What you can do

- **Answer from your own documentation.** Publish delivery policies, return conditions, and support procedures. The assistant searches your company's published documents and cites the sources used in its answer.
- **Work with orders and tickets.** Read Shopify orders, create tickets linked to a purchase, mark them resolved, and return to previous conversations.
- **Review refunds before they happen.** A refund needs a proposal, approval by another person, and explicit execution. Managers have a configurable approval ceiling; administrators handle requests above it.
- **Manage your workspace.** Invite colleagues, assign roles, suspend access, and configure the assistant's language and tone. Settings keep a revision history.
- **Maintain a document library.** Save drafts, publish new versions, track indexing, retry failures, and withdraw outdated procedures. A draft never replaces a published version until indexing succeeds.

## Quick start

### Requirements

- Node.js **24** and npm — the Node version is also pinned in [`.nvmrc`](.nvmrc).
- Docker with Docker Compose, for PostgreSQL and pgvector.
- AWS credentials with access to the configured Bedrock models, for chat and document indexing.

The local interface and workspace administration run without Cognito or Shopify. Chat and indexing still call Bedrock; they are not simulated offline.

### 1. Install and prepare the database

```bash
git clone https://github.com/Gleaming0427/helio-resolve.git
cd helio-resolve

cp .env.example .env
npm ci
docker compose up -d --wait postgres

npm run db:generate
npm run db:deploy
npm run build:packages
npm run db:seed
```

Already have a checkout? Keep your existing `.env` and skip the clone and copy steps.

The seed creates a demo administrator, a demo support agent, and a paid **€49 order**. Copy the order ID printed in the terminal: each seed run creates a new order.

### 2. Configure Bedrock

The defaults in `.env` are:

```dotenv
AWS_REGION=eu-west-3
BEDROCK_MODEL_ID=eu.amazon.nova-pro-v1:0
BEDROCK_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0
```

Use an AWS credential profile available to the API and worker processes. If you use a named profile, set `AWS_PROFILE` in their environment. AWS credentials belong on the server, never in `VITE_*` variables.

For local authentication, keep both `AUTH_MODE=dev` and `VITE_AUTH_MODE=dev`, as supplied in [`.env.example`](.env.example).

### 3. Start the application

Run these commands in **three separate terminals**, from the repository root:

```bash
# Terminal 1 — API
npm run dev-api
```

```bash
# Terminal 2 — web interface
npm run dev-web
```

```bash
# Terminal 3 — document indexing
npm run dev-worker
```

Open **[localhost:5173](http://localhost:5173)**. The API runs at [localhost:3000](http://localhost:3000/health).

## Try the demo

The interface currently uses French labels. In development, the **“agir en tant que”** selector switches between the demo administrator and support agent.

### Ask a question about a procedure

1. As the administrator, open **Documents** and create a document titled “Delivery policy”.
2. Paste: “Express delivery costs €9.90 and takes 24–48 hours. Standard delivery is free for orders over €50.”
3. Save the draft, click **Publier**, and wait for **Publié**.
4. In the assistant, ask: “According to our documentation, how much does express delivery cost?”

Edit the document to create another version. The existing published version stays available until you publish the replacement. Withdrawing a document excludes it from future searches.

### Walk through a refund

1. Switch to the support agent and ask the assistant to propose a refund for the order ID printed by `db:seed`. Include a reason, such as a damaged item.
2. Switch to the administrator and open **Approbations**.
3. Review the proposal, approve it, then execute the refund.

The proposal's author cannot approve it. Without a connected store, the local demo uses a simulated payment provider: no money is transferred. Run `npm run db:seed` again when you need another paid demo order.

### Connect a Shopify store

An administrator can connect a store from **Réglages**. In local development, set `LOCAL_SECRET_KEY` in `.env` to a key generated with `openssl rand -base64 32`, then restart the API. Keep this key stable so saved credentials remain readable.

Use a development store for testing. The [Shopify pilot guide](docs/shopify-pilot.md) covers store setup, required permissions, supported orders, and refund recovery. Connecting a store makes Helio use that store's orders and payment provider.

## Architecture

Helio separates the support interface, business decisions, and external services:

```text
apps/
  web/          React + Vite support console
  api/          Fastify API, authentication, and authorization
  workers/      Asynchronous document indexing
packages/
  domain/       Business entities, value objects, and rules
  application/  Use cases and service interfaces
  adapters/     Prisma, pgvector, Bedrock, Shopify, and KMS
infra/
  cdk/          AWS infrastructure
```

**Business rules remain in control.** Bedrock can request tools, but the application validates access, order state, and approval requirements. Refund execution is an explicit human action.

**Each company has its own workspace.** Persisted memberships determine access. Documents and business records are scoped to the authenticated company; conversations are private to their author. Local identity switching is disabled in production.

**Background work survives interruptions.** PostgreSQL stores document publication jobs and refund execution intents. Document versions become searchable atomically. Refund retries reuse the recorded payment context and idempotency key. See [refund transactions and recovery](docs/refund-recovery.md).

## Testing

After completing local setup:

```bash
npm run typecheck
npm test
npm run build
```

The PostgreSQL integration suite covers company isolation, concurrent changes, document publication, and refund recovery. It requires a dedicated database named `helio_refund_test` and clears test data.

<details>
<summary>Run integration tests with a separate PostgreSQL container</summary>

Start a test database on a different port from the application database:

```bash
docker run --name helio-tests \
  -e POSTGRES_USER=helio \
  -e POSTGRES_PASSWORD=helio_test \
  -e POSTGRES_DB=helio_refund_test \
  -p 127.0.0.1:55432:5432 \
  -d pgvector/pgvector:pg17
```

Wait until `docker exec helio-tests pg_isready -U helio -d helio_refund_test` reports that PostgreSQL is accepting connections, then run:

```bash
DATABASE_URL=postgresql://helio:helio_test@localhost:55432/helio_refund_test npm run db:deploy
HELIO_TEST_DATABASE_URL=postgresql://helio:helio_test@localhost:55432/helio_refund_test npm run test:integration
```

The standard integration suite uses simulated external providers. Tests against a real Shopify development store are opt-in; see the pilot guide.

Stop the test container with `docker stop helio-tests`; restart it later with `docker start helio-tests`.

</details>

[GitHub Actions](.github/workflows/ci.yml) runs type checks, unit tests, and PostgreSQL integration tests on pushes to `main` and on pull requests.

## Deployment and operations

The repository includes an AWS CDK stack for ECS/Fargate, RDS PostgreSQL, Bedrock access, Cognito, KMS, an HTTPS load balancer, WAF, S3/CloudFront, and worker alarms.

The [operations guide](docs/operations.md) covers deployment requirements, first-administrator setup, database upgrades, quotas, and troubleshooting. Infrastructure deployment, database migrations, and frontend publishing are separate steps. The stack is a starting point for deployment; the guide identifies the remaining production work.

## Documentation

- [Operations and AWS deployment](docs/operations.md)
- [Shopify pilot and development-store testing](docs/shopify-pilot.md) — French
- [Refund transactions and recovery](docs/refund-recovery.md) — French
- [Environment variables](.env.example)
