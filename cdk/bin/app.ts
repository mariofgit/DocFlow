#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DoclingServiceStack } from "../lib/docling-service-stack";

const app = new cdk.App();
const envName = (app.node.tryGetContext("env") as string) || "staging";

new DoclingServiceStack(app, `DoclingServiceStack-${envName}`, {
  envName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  description: `Docling document conversion service (${envName})`,
});
