// Find unassociated Elastic IPs. Each costs $0.005/hour = ~$3.60/month.
import { EC2Client, DescribeAddressesCommand } from "@aws-sdk/client-ec2";

export const name = "idle_public_ipv4";

const COST_PER_EIP_PER_MONTH = 3.60;

export async function run({ region }) {
  const client = new EC2Client({ region });
  const findings = [];

  const res = await client.send(new DescribeAddressesCommand({}));
  for (const addr of res.Addresses || []) {
    if (!addr.AssociationId) {
      findings.push({
        resourceId: addr.AllocationId || addr.PublicIp,
        region,
        estimatedMonthlyCost: COST_PER_EIP_PER_MONTH,
        details: {
          publicIp: addr.PublicIp,
          domain: addr.Domain,
          tags: addr.Tags || [],
        },
      });
    }
  }

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### Idle Public IPv4 (Elastic IPs)\n\nNo unassociated Elastic IPs found.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Idle Public IPv4 (Elastic IPs)`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} unassociated Elastic IP(s) found. Each costs $3.60/month while unused (since Feb 2024).`,
    "",
    "| Public IP | Allocation ID | Tags |",
    "|-----------|---------------|------|",
  ];

  for (const f of findings) {
    const tagStr =
      (f.details.tags || [])
        .map((t) => `${t.Key}=${t.Value}`)
        .join(", ") || "—";
    lines.push(`| ${f.details.publicIp} | \`${f.resourceId}\` | ${tagStr} |`);
  }

  lines.push("");
  lines.push("**Fix:** Release with `aws ec2 release-address --allocation-id ALLOC_ID`.");
  lines.push("");
  lines.push("**Docs:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html");

  return lines.join("\n") + "\n";
}
