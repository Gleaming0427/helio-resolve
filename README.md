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
- S3 + SQS + worker for asynchronous document ingestion.
- Cognito for OIDC/PKCE in production.
- Human approval before refund execution.
- Application-level audit of sensitive actions.
- CDK for VPC, RDS, ECS/Fargate, ALB, WAF, S3, SQS, Cognito, and CloudFront.

## Local startup of the core app and database
```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm test
npm run typecheck
```
The seed creates the order `ord_DEMO123` in tenant `ten_DEMO123`.

## Local authentication
To learn and develop without Cognito, keep:
```env
NODE_ENV=development
AUTH_MODE=dev
VITE_AUTH_MODE=dev
DEV_TENANT_ID=ten_DEMO123
DEV_USER_ID=usr_DEMO123
DEV_ROLES=support_manager,tenant_admin
```
The bypass is explicitly disabled when `NODE_ENV=production`.

## Start the API and frontend
Terminal 1:
```bash
npm run dev:api
```
Terminal 2:
```bash
npm run dev:web
```
Then open `http://localhost:5173`.

## Using Bedrock and RAG
Real chat requires AWS credentials and access to the configured models in:
```env
AWS_REGION=eu-west-3
BEDROCK_MODEL_ID=eu.amazon.nova-pro-v1:0
BEDROCK_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0
```
Document ingestion also uses an S3 bucket and an SQS queue. In AWS, the CDK creates them and injects their
values into the ECS tasks.

HELIO RESOLVE | APPLICATION COMPLETE - 67 FILES
Complete code - React / Node / PostgreSQL / Bedrock / AWS

## Cognito in production
The frontend uses Authorization Code + PKCE. The API expects a valid Cognito access token. Groups have two
roles:
- `support_manager`: can approve and execute refunds.
- `tenant_admin`: can upload knowledge documents.
- exactly one group `tenant__<TenantId>`: determines the tenant, for example `tenant__ten_ACME123`.
The tenant is never accepted from the request body.

## AWS deployment
Build the frontend first, then sync `apps/web/dist` to the web bucket created by CDK. For the API and worker,
`ContainerImage.fromAsset()` builds the Dockerfiles and pushes the images to an ECR repository managed by the
CDK assets.
Before a real production rollout, add an ACM certificate and an HTTPS listener on the ALB, a secret rotation
strategy, CloudWatch alarms, CloudTrail, GuardDuty Runtime Monitoring, and agentic integration/evaluation tests
in CI.
