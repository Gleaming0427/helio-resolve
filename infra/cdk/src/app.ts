import { App } from "aws-cdk-lib";
import { HelioStack } from "./HelioStack.js";
const app = new App();
const apiDomainName = process.env.API_DOMAIN_NAME;
const apiCertificateArn = process.env.API_CERTIFICATE_ARN;
if (!apiDomainName || !apiCertificateArn) {
  throw new Error("Set API_DOMAIN_NAME and API_CERTIFICATE_ARN (ACM certificate in the stack region): the API is served over HTTPS only.");
}
new HelioStack(app, "HelioResolveStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-west-3",
  },
  apiDomainName,
  apiCertificateArn,
  ...(process.env.ALARM_EMAIL ? { alarmEmail: process.env.ALARM_EMAIL } : {}),
});
