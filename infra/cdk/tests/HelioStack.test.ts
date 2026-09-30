import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, expect, it } from "vitest";
import { HelioStack } from "../src/HelioStack.js";

const certificate = "arn:aws:acm:eu-west-3:123456789012:certificate/11111111-2222-3333-4444-555555555555";
const stack = (props: { apiDomainName?: string; apiCertificateArn?: string; alarmEmail?: string } = {}) =>
  new HelioStack(new App(), "Test", {
    env: { account: "123456789012", region: "eu-west-3" },
    apiDomainName: "api.example.com", apiCertificateArn: certificate, ...props,
  });
let template: Template;
beforeAll(() => { template = Template.fromStack(stack()); }, 60_000);

it("serves the API over HTTPS only, with a modern TLS policy", () => {
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
    Port: 443, Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    Certificates: [{ CertificateArn: certificate }],
  });
  template.hasOutput("ApiUrl", { Value: "https://api.example.com" });
});

it("opens no plain HTTP port on the load balancer", () => {
  const groups = template.findResources("AWS::EC2::SecurityGroup", {
    Properties: { GroupDescription: Match.stringLikeRegexp("ApiAlb") },
  });
  const ingress = Object.values(groups).flatMap(group => group.Properties.SecurityGroupIngress ?? []);
  expect(ingress.map((rule: { FromPort: number }) => rule.FromPort)).toEqual([443]);
});

it("alarms when document indexing fails or no worker is running", () => {
  template.hasResourceProperties("AWS::Logs::MetricFilter", {
    FilterPattern: '{ $.level = "error" }',
    MetricTransformations: [Match.objectLike({ MetricNamespace: "Helio", MetricName: "DocumentWorkerErrors", MetricValue: "1" })],
  });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "DocumentWorkerErrors", Statistic: "Sum", Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
    AlarmActions: [Match.objectLike({ Ref: Match.stringLikeRegexp("OperationsAlarms") })],
  });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    Namespace: "AWS/ECS", MetricName: "CPUUtilization", Statistic: "SampleCount",
    Dimensions: Match.arrayWith([Match.objectLike({ Name: "ServiceName", Value: Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("WorkerService"), "Name"] }) })]),
    ComparisonOperator: "LessThanThreshold", TreatMissingData: "breaching",
    AlarmActions: [Match.objectLike({ Ref: Match.stringLikeRegexp("OperationsAlarms") })],
  });
  template.resourceCountIs("AWS::SNS::Subscription", 0);
});

it("grants no access to the retired S3/SQS ingestion path", () => {
  template.resourceCountIs("AWS::SQS::Queue", 0);
  const actions = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement)
    .flatMap((statement: { Action: string | string[] }) => [statement.Action].flat());
  expect(actions.filter(action => /^(s3|sqs):/.test(action))).toEqual([]);
  const variables = Object.values(template.findResources("AWS::ECS::TaskDefinition"))
    .flatMap(task => task.Properties.ContainerDefinitions)
    .flatMap((container: { Environment?: { Name: string }[] }) => container.Environment ?? [])
    .map(variable => variable.Name);
  expect(variables).not.toContain("KNOWLEDGE_BUCKET");
  expect(variables).not.toContain("INGEST_QUEUE_URL");
});

it("encrypts store credentials with a rotated KMS key that only the API can use", () => {
  template.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  const [keyId] = Object.keys(template.findResources("AWS::KMS::Key"));
  const api = Object.values(template.findResources("AWS::ECS::TaskDefinition")).find(task => JSON.stringify(task).includes("SECRET_KMS_KEY_ID"));
  expect(JSON.stringify(api)).toContain(keyId);
  const kmsPolicies = Object.entries(template.findResources("AWS::IAM::Policy"))
    .filter(([, policy]) => JSON.stringify(policy.Properties.PolicyDocument).includes(keyId!));
  expect(kmsPolicies.map(([, policy]) => JSON.stringify(policy.Properties.Roles))).toEqual([expect.stringContaining("ApiTaskTaskRole")]);
});

it("subscribes the operations email to alarms when configured", () => {
  const withEmail = Template.fromStack(stack({ alarmEmail: "ops@example.com" }));
  withEmail.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
}, 60_000);

it.each([{ apiDomainName: "" }, { apiDomainName: "http://api.example.com" }, { apiCertificateArn: "" }])(
  "refuses to synthesize without a valid HTTPS configuration: %j", (override) => {
    expect(() => stack(override)).toThrow();
  });
