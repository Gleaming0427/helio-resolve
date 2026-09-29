import { App } from "aws-cdk-lib";
import { HelioStack } from "./HelioStack.js";
const app = new App();
new HelioStack(app, "HelioResolveStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-west-3",
  },
});
