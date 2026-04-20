import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

interface DeploymentConfig {
  cpu: number;
  memory: number;
  desiredCount: number;
  public: boolean;
  /** Optional; forwarded as GUNICORN_WORKERS (defaults in image: 2). */
  gunicornWorkers?: number;
  publicDns: {
    hostedZoneId: string;
    apexDomain: string;
    tenantSubdomainPrefix: string;
  };
}

interface DoclingServiceStackProps extends cdk.StackProps {
  envName: string;
}

export class DoclingServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DoclingServiceStackProps) {
    super(scope, id, props);

    const deploymentPath = path.join(__dirname, "..", "deployment.json");
    const deployment = JSON.parse(
      fs.readFileSync(deploymentPath, "utf8")
    ) as Record<string, DeploymentConfig>;
    const cfg = deployment[props.envName];
    if (!cfg) {
      throw new Error(`Unknown env "${props.envName}" in deployment.json`);
    }

    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2 });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: cfg.publicDns.hostedZoneId,
      zoneName: cfg.publicDns.apexDomain,
    });

    const domainName = `${cfg.publicDns.tenantSubdomainPrefix}.${cfg.publicDns.apexDomain}`;

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const apiKeySecret = new secretsmanager.Secret(this, "ApiKeySecret", {
      secretName: `docling-service/${props.envName}/api-key`,
      description: "API key for X-API-Key header (DOCLING_API_KEY in container)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "password",
        passwordLength: 48,
        excludeCharacters: "\"@/\\",
      },
    });

    // Same path docker-compose uses: ./service → Dockerfile + entrypoint + FastAPI app.
    const serviceDir = path.join(__dirname, "..", "..", "service");

    const taskEnvironment: Record<string, string> = {
      // Must match container EXPOSE / docker-compose ports / local demo.
      PORT: "8080",
    };
    if (cfg.gunicornWorkers != null && cfg.gunicornWorkers > 0) {
      taskEnvironment.GUNICORN_WORKERS = String(cfg.gunicornWorkers);
    }

    const fargate =
      new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
        cluster,
        cpu: cfg.cpu,
        memoryLimitMiB: cfg.memory,
        desiredCount: cfg.desiredCount,
        publicLoadBalancer: cfg.public,
        assignPublicIp: true,
        domainName,
        domainZone: zone,
        certificate,
        taskImageOptions: {
          image: ecs.ContainerImage.fromAsset(serviceDir),
          containerPort: 8080,
          environment: taskEnvironment,
          secrets: {
            DOCLING_API_KEY: ecs.Secret.fromSecretsManager(
              apiKeySecret,
              "password"
            ),
          },
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: "docling",
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
        },
        healthCheckGracePeriod: cdk.Duration.seconds(180),
      });

    fargate.targetGroup.configureHealthCheck({
      path: "/health",
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
    });

    new cdk.CfnOutput(this, "ServiceUrl", {
      value: `https://${domainName}`,
      description: "Public HTTPS URL",
    });
    new cdk.CfnOutput(this, "ApiKeySecretArn", {
      value: apiKeySecret.secretArn,
      description:
        "Retrieve DOCLING_API_KEY after deploy: aws secretsmanager get-secret-value ...",
    });
  }
}
