import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { fileURLToPath } from "node:url";
export class HelioStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
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
    const knowledgeBucket = new s3.Bucket(this, "KnowledgeBucket", {
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
    const deadLetterQueue = new sqs.Queue(this, "IngestDlq", {
      retentionPeriod: Duration.days(14),
    });
    const ingestQueue = new sqs.Queue(this, "IngestQueue", {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 5,
      },
    });
    const userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false,
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
        AWS_REGION: this.region,
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: "helio",
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        INGEST_QUEUE_URL: ingestQueue.queueUrl,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        BEDROCK_MODEL_ID:
          process.env.BEDROCK_MODEL_ID ?? "eu.amazon.nova-pro-v1:0",
        BEDROCK_EMBED_MODEL_ID:
          process.env.BEDROCK_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
        WEB_ORIGIN: `https://${webDistribution.distributionDomainName}`,
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
    knowledgeBucket.grantReadWrite(apiTask.taskRole);
    ingestQueue.grantSendMessages(apiTask.taskRole);
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "ApiAlb", {
      vpc,
      internetFacing: true,
    });
    const listener = loadBalancer.addListener("Http", {
      port: 80,
    });
    listener.addTargets("ApiTargets", {
      port: 3000,
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
    workerTask.addContainer("Worker", {
      image: ecs.ContainerImage.fromAsset(repoRoot, {
        file: "Dockerfile.worker",
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "helio-worker",
      }),
      environment: {
        NODE_ENV: "production",
        AWS_REGION: this.region,
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: "helio",
        INGEST_QUEUE_URL: ingestQueue.queueUrl,
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
    knowledgeBucket.grantRead(workerTask.taskRole);
    ingestQueue.grantConsumeMessages(workerTask.taskRole);
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      }),
    );
    new CfnOutput(this, "ApiUrl", {
      value: `http://${loadBalancer.loadBalancerDnsName}`,
    });
    new CfnOutput(this, "WebDistributionUrl", {
      value: `https://${webDistribution.distributionDomainName}`,
    });
    new CfnOutput(this, "WebBucketName", {
      value: webBucket.bucketName,
    });
  }
}
