// Find VPCs that have NAT Gateways but no S3 / DynamoDB Gateway Endpoints.
// Gateway Endpoints are FREE. Traffic to S3/DynamoDB through NAT costs $0.045/GB processed.
import {
  EC2Client,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
} from "@aws-sdk/client-ec2";

export const name = "nat_missing_endpoints";

// Conservative: assume each missing endpoint per active NAT saves ~$30/month.
// Actual savings depend on traffic volume and may be much higher.
const ESTIMATED_SAVINGS_PER_MISSING_ENDPOINT = 30;

export async function run({ region }) {
  const client = new EC2Client({ region });
  const findings = [];

  const natRes = await client.send(new DescribeNatGatewaysCommand({}));
  const activeNats = (natRes.NatGateways || []).filter(
    (n) => n.State === "available"
  );

  if (activeNats.length === 0) return findings;

  const vpcsWithNats = new Set(activeNats.map((n) => n.VpcId));

  const endpointRes = await client.send(new DescribeVpcEndpointsCommand({}));
  const endpointsByVpc = new Map();
  for (const ep of endpointRes.VpcEndpoints || []) {
    if (!endpointsByVpc.has(ep.VpcId)) endpointsByVpc.set(ep.VpcId, []);
    endpointsByVpc.get(ep.VpcId).push(ep);
  }

  for (const vpcId of vpcsWithNats) {
    const endpoints = endpointsByVpc.get(vpcId) || [];
    const services = new Set(endpoints.map((e) => e.ServiceName));
    const hasS3 = [...services].some((s) => s.endsWith(".s3"));
    const hasDynamo = [...services].some((s) => s.endsWith(".dynamodb"));

    const missing = [];
    if (!hasS3) missing.push("S3");
    if (!hasDynamo) missing.push("DynamoDB");

    if (missing.length > 0) {
      const natCount = activeNats.filter((n) => n.VpcId === vpcId).length;
      findings.push({
        resourceId: vpcId,
        region,
        estimatedMonthlyCost:
          missing.length * ESTIMATED_SAVINGS_PER_MISSING_ENDPOINT * natCount,
        details: {
          natGatewayCount: natCount,
          missingEndpoints: missing,
          existingEndpoints: [...services],
        },
      });
    }
  }

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### NAT Gateway / VPC Endpoint Configuration\n\nNo NAT Gateways without proper Gateway Endpoints. Either no NATs, or all VPCs have S3/DynamoDB endpoints.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Missing VPC Gateway Endpoints (NAT waste)`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month (conservative — actual savings depend on traffic volume)`,
    "",
    `${findings.length} VPC(s) with NAT Gateways but missing free S3/DynamoDB Gateway Endpoints. Traffic to those services is being routed through NAT at $0.045/GB instead of free.`,
    "",
    "| VPC | NAT Count | Missing Endpoints |",
    "|-----|-----------|-------------------|",
  ];

  for (const f of findings) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.natGatewayCount} | ${f.details.missingEndpoints.join(", ")} |`
    );
  }

  lines.push("");
  lines.push("**Fix:** Add Gateway Endpoints in the VPC console. They're free, applied in minutes.");
  lines.push("");
  lines.push("**Docs:** https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html");

  return lines.join("\n") + "\n";
}
