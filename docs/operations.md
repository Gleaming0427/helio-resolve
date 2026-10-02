# Operations guide

For local installation and a first walkthrough, start with the [README](../README.md).

## AWS deployment

The CDK stack provisions the API and document worker on ECS/Fargate, PostgreSQL on RDS, Cognito authentication, a KMS key for store credentials, and a frontend bucket served through CloudFront. The API sits behind an HTTPS application load balancer and WAF. Worker alarms publish to an SNS topic.

### Prepare the deployment

Use an AWS account and region with access to the configured Bedrock models. You also need an API hostname and an ACM certificate for that hostname in the stack's region.

Set these variables in the shell running CDK, replacing the example values:

```bash
export API_DOMAIN_NAME=api.example.com
export API_CERTIFICATE_ARN=arn:aws:acm:eu-west-3:123456789012:certificate/REPLACE_ME
export WEB_CALLBACK_URL=https://YOUR_FRONTEND_HOST/callback
export WEB_LOGOUT_URL=https://YOUR_FRONTEND_HOST/
export ALARM_EMAIL=operations@example.com
```

`ALARM_EMAIL` is optional; confirm the subscription email if you set it. The CDK app refuses to synthesize without the API hostname and certificate ARN. Callback and logout URLs must match the frontend used for sign-in; update them when its final hostname is known.

The entry point is [`infra/cdk/src/app.ts`](../infra/cdk/src/app.ts). It reads `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`, with `eu-west-3` as the region fallback. There is no `cdk.json` in the repository, so pass the app explicitly. After `npm run build`, inspect the template from the repository root with:

```bash
npm exec -w @helio/infra -- cdk synth --app "node dist/app.js"
```

Review the generated resources and configure CDK bootstrapping for the target account before deploying. Synthesis does not deploy the application.

### Bring the application online

1. **Deploy the stack.** CDK builds the API and worker Docker images from the repository and publishes them through its ECR assets.
2. **Apply database migrations.** Run `npm run db:deploy` from a migration environment with the repository's development dependencies, credentials, and network access to private RDS. The API and worker images do not run migrations automatically. For an existing installation, coordinate schema changes with the running application versions.
3. **Configure API DNS.** Point `API_DOMAIN_NAME` to the `ApiLoadBalancerDnsName` stack output. The load balancer accepts HTTPS on port 443 and has no HTTP listener.
4. **Configure the frontend.** Set `VITE_API_URL` to the `ApiUrl` output and `VITE_AUTH_MODE=cognito`. Set the Cognito client ID, authority, and redirect URI to match the deployed user pool and client. These values are embedded at build time.
5. **Publish the frontend.** Build `@helio/web` and upload `apps/web/dist` to the bucket identified by `WebBucketName`. Invalidate the relevant CloudFront cache when replacing an existing build. The stack also outputs `WebDistributionUrl`.
6. **Verify the deployed application.** Check sign-in, workspace access, document publication, and a development-store refund before connecting live customer operations.

The API's allowed web origin is the stack's CloudFront distribution URL. A custom frontend domain also needs corresponding CORS and Cognito configuration changes. Frontend builds reject a plain HTTP API URL except on localhost.

The stack grants the API task access to its KMS key and supplies `SECRET_KMS_KEY_ID`. An operator recovering Shopify refunds needs database access and `kms:Decrypt` on that key.

### Remaining production work

Plan database secret rotation, API error and latency alarms, CloudTrail, runtime monitoring, conversation retention, and evaluations of assistant answers. Conversations can contain customer data. These operational policies are not completed by deploying the stack.

## Identity and workspace access

The frontend uses Cognito Authorization Code with PKCE. The API verifies access tokens; PostgreSQL memberships determine the company and permissions.

To bootstrap the first administrator, assign a trusted Cognito identity the groups `tenant_admin` and exactly one `tenant__<TenantId>` group, such as `tenant__ten_ACME123`. Bootstrap only succeeds if the workspace has no members.

After bootstrap, manage access from the application:

- `support_agent` uses the assistant and tickets.
- `support_manager` also approves, rejects, and executes refunds within the configured ceiling.
- `tenant_admin` manages settings, members, documents, the Shopify connection, and refunds above the manager ceiling.

Nobody can approve a refund proposal they authored. Database suspensions and role changes take precedence over old Cognito group claims.

Invitations are single-use links valid for seven days, shared manually by an administrator. Helio does not send invitation emails. The stack enables self-registration and email verification; creating an identity alone grants no workspace access. Invitees need no tenant groups in Cognito.

The member list uses Cognito-verified email addresses. Local development displays an unverified-email indication and the user's ID instead. Use separate Cognito accounts to validate registration and invitations.

## Database upgrades

For an existing local checkout, keep `.env` and run:

```bash
npm ci
npm run db:generate
npm run db:deploy
npm run build:packages
```

Restart the API and worker after updating their shared packages. Use `db:deploy` to apply checked-in migrations; use `db:migrate` when developing a new schema change.

Prisma, semantic search, and the migration CLI share database configuration. They accept `DATABASE_URL`, or the separate `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` variables.

Older installations need these migration notes:

- `0004_workspace_lifecycle` returns existing managed documents to draft. Republish them from the library.
- `0005_import_legacy_knowledge` groups old index fragments by company and title into published imported documents. The old index did not preserve paragraph order: review imported text before editing. Matching titles within one company are grouped without discarding their fragments.
- `0006_quota_window` adds the shared tenant quota counter.
- `0007_business_integration` recovers existing proposal authors from the audit and associates existing refund intents with the simulated provider.

The former S3/SQS document-ingestion path is removed. The updated stack removes its queues and retains the old knowledge bucket for its data, without API or worker access.

## Document processing

PostgreSQL stores publication requests. The worker generates embeddings and publishes a complete version in one database transaction. The previously published version remains searchable while a replacement is in draft or its indexing has failed.

An interrupted job can be reclaimed after five minutes. Failed jobs can be retried from the library. The UI warns when a document has been queued for more than two minutes or its processing lease has expired; check worker health and logs in either case.

Worker logs include `document_indexed`, `document_indexing_superseded`, and `document_indexing_failed`. Stored failure codes distinguish `embedding_failed` from `storage_failed`.

AWS alarms cover worker errors and the absence of a running worker task. Notifications go to the `AlarmTopicArn` output. Withdrawing a document removes it from future searches; it does not erase answers already displayed in conversations.

## Refund recovery

A refund records its execution intent before calling the provider. After a timeout or lost response, retries reuse the recorded account and key. Do not delete the intent or replace its key to retry.

Operators can resume pending execution intents with:

```bash
npm run refunds:resume
# Process at most 50 intents
npm run refunds:resume -- 50
```

This is a manual command, not an automatically scheduled worker. It does not execute approvals that have never been submitted for execution. Definitive provider refusals are not retried.

See the [transaction and recovery guide](refund-recovery.md) and [Shopify pilot guide](shopify-pilot.md) for the payment lifecycle and reconciliation behavior.

## Quotas and troubleshooting

Chat is limited to 20 requests per minute per company. Document creation and publication share a limit of 10 per minute per company. Both use PostgreSQL counters shared by API instances.

The API also applies a per-instance limit of 120 requests per minute per client IP; WAF supplies the shared IP rule. Set `TRUST_PROXY_HOPS=1` behind the stack's ALB and leave it empty for direct local access.

Every API response includes a unique `x-request-id`. The interface shows this reference for unexpected failures. Search API logs for its `reqId` to locate the request. Internal errors are logged with credentials scrubbed; clients receive no internal stack traces.

- **Document stays queued:** check that `npm run dev-worker` is running locally, or inspect the ECS worker service and alarms.
- **Indexing fails:** inspect the failure code and worker logs for Bedrock access or database errors, fix the cause, then retry publication.
- **Workspace access is refused:** check persisted membership, its active status, and the account used to sign in. Cognito registration alone is insufficient.
- **Local requests fail after configuration changes:** restart the API, web server, and worker as needed. API and frontend authentication modes must agree.
- **A refund cannot be approved:** verify that the reviewer is not its author and has the required role and approval ceiling.
