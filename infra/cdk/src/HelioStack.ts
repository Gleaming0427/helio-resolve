import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { fileURLToPath } from "node:url";
export type HelioStackProps = StackProps & {
  // Bearer tokens must never cross the internet in clear text: the API is HTTPS only.
  apiDomainName: string;
  /** ACM certificate for apiDomainName, in the stack region. */
  apiCertificateArn: string;
  /** Receives operations alarms (confirm the SNS subscription email). */
  alarmEmail?: string;
};
export class HelioStack extends Stack {
  constructor(scope: Construct, id: string, props: HelioStackProps) {
    super(scope, id, props);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(props.apiDomainName)) {
      throw new Error("apiDomainName must be a host name such as api.example.com");
    }
    if (!props.apiCertificateArn.startsWith("arn:")) {
      throw new Error("apiCertificateArn must be an ACM certificate ARN");
    }
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: "app",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          name: "db",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      databaseName: "helio",
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      credentials: rds.Credentials.fromGeneratedSecret("helio"),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: Duration.days(7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
    // Uploads from before the document library (now stored in PostgreSQL). Kept for
    // their data; no service reads or writes it, so no task role is granted access.
    new s3.Bucket(this, "KnowledgeBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const webBucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const webDistribution = new cloudfront.Distribution(
      this,
      "WebDistribution",
      {
        defaultRootObject: "index.html",
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.minutes(1),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.minutes(1),
          },
        ],
      },
    );
    const userPool = new cognito.UserPool(this, "Users", {
      // Signing up creates an identity only; workspace access requires an invitation.
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
    });
    const userPoolClient = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          process.env.WEB_CALLBACK_URL ?? "http://localhost:5173/callback",
        ],
        logoutUrls: [process.env.WEB_LOGOUT_URL ?? "http://localhost:5173/"],
      },
    });
    userPool.addDomain("HostedDomain", {
      cognitoDomain: {
        domainPrefix: `helio-resolve-${this.account}`.toLowerCase(),
      },
    });
    new cognito.CfnUserPoolGroup(this, "SupportManagerGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "support_manager",
      description: "Can approve and execute sensitive support actions",
    });
    new cognito.CfnUserPoolGroup(this, "TenantAdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "tenant_admin",
      description: "Can manage tenant knowledge documents",
    });
    // Provision one group per tenant, for example tenant__ten_ACME123.
    // Cognito access tokens include cognito:groups by default, so the API
    // can derive tenancy without trusting a request body field.
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    // Encrypts each tenant's store credentials (Shopify access token) before they reach
    // PostgreSQL, with the tenant as encryption context. Only the API role can use it.
    const secretsKey = new kms.Key(this, "TenantSecretsKey", {
      description: "Helio tenant store credentials",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const apiContainer = apiTask.addContainer("Api", {
      image: ecs.ContainerImage.fromAsset(repoRoot, {
        file: "Dockerfile.api",
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "helio-api",
      }),
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        // The ALB is the only proxy in front of the API.
        TRUST_PROXY_HOPS: "1",
        AWS_REGION: this.region,
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: "helio",
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        BEDROCK_MODEL_ID:
          process.env.BEDROCK_MODEL_ID ?? "eu.amazon.nova-pro-v1:0",
        BEDROCK_EMBED_MODEL_ID:
          process.env.BEDROCK_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
        WEB_ORIGIN: `https://${webDistribution.distributionDomainName}`,
        SECRET_KMS_KEY_ID: secretsKey.keyArn,
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(
          database.secret!,
          "password",
        ),
      },
    });
    apiContainer.addPortMappings({ containerPort: 3000 });
    secretsKey.grantEncryptDecrypt(apiTask.taskRole);
    apiTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      }),
    );
    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
    database.connections.allowDefaultPortFrom(apiService);
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "ApiAlb", {
      vpc,
      internetFacing: true,
    });
    // No port 80 listener, not even a redirect: a token sent over HTTP has
    // already leaked before any redirect could answer.
    const listener = loadBalancer.addListener("Https", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(props.apiCertificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });
    // TLS ends at the ALB; tasks are only reachable from it, in private subnets.
    listener.addTargets("ApiTargets", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200",
      },
    });
    const webAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "helio-api-waf",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedCommon",
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "managed-common",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "IpRateLimit",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "IP",
              limit: 2_000,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ip-rate-limit",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "ApiWebAclAssociation", {
      resourceArn: loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const workerLogs = new logs.LogGroup(this, "WorkerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
    });
    workerTask.addContainer("Worker", {
      image: ecs.ContainerImage.fromAsset(repoRoot, {
        file: "Dockerfile.worker",
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "helio-worker",
        logGroup: workerLogs,
      }),
      environment: {
        NODE_ENV: "production",
        AWS_REGION: this.region,
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: "helio",
        BEDROCK_EMBED_MODEL_ID:
          process.env.BEDROCK_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(
          database.secret!,
          "password",
        ),
      },
    });
    const workerService = new ecs.FargateService(this, "WorkerService", {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
    database.connections.allowDefaultPortFrom(workerService);
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      }),
    );
    // Document indexing is asynchronous: without these alarms, a failing or stopped
    // worker only shows up as documents that never become available in the chat.
    const alarmTopic = new sns.Topic(this, "OperationsAlarms");
    if (props.alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }
    const workerErrors = workerLogs.addMetricFilter("WorkerErrors", {
      filterPattern: logs.FilterPattern.stringValue("$.level", "=", "error"),
      metricNamespace: "Helio",
      metricName: "DocumentWorkerErrors",
      metricValue: "1",
      defaultValue: 0,
    });
    const workerAlarms = [
      new cloudwatch.Alarm(this, "DocumentWorkerErrorsAlarm", {
        alarmDescription: "Document indexing failed or the worker cannot reach PostgreSQL/Bedrock. " +
          "Search the worker logs for document_indexing_failed or document_worker_unavailable.",
        metric: workerErrors.metric({ statistic: "Sum", period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // A running task reports CPU every minute; no samples means no worker.
      new cloudwatch.Alarm(this, "DocumentWorkerDownAlarm", {
        alarmDescription: "No document worker task is running: published documents stay queued.",
        metric: workerService.metricCpuUtilization({ statistic: "SampleCount", period: Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    ];
    for (const alarm of workerAlarms) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }
    new CfnOutput(this, "AlarmTopicArn", {
      value: alarmTopic.topicArn,
    });
    new CfnOutput(this, "ApiUrl", {
      value: `https://${props.apiDomainName}`,
    });
    // Point apiDomainName to this name (CNAME, or a Route 53 alias).
    new CfnOutput(this, "ApiLoadBalancerDnsName", {
      value: loadBalancer.loadBalancerDnsName,
    });
    new CfnOutput(this, "WebDistributionUrl", {
      value: `https://${webDistribution.distributionDomainName}`,
    });
    new CfnOutput(this, "WebBucketName", {
      value: webBucket.bucketName,
    });
  }
}
