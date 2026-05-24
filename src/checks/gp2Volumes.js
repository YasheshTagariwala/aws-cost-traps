// Find EBS gp2 volumes that should be migrated to gp3 (~20% cheaper, free migration).
import { EC2Client, DescribeVolumesCommand } from "@aws-sdk/client-ec2";

export const name = "gp2_volumes";

const GP2_PER_GB = 0.10;
const GP3_PER_GB = 0.08;
const SAVINGS_PER_GB = GP2_PER_GB - GP3_PER_GB; // $0.02/GB-month

export async function run({ region }) {
  const client = new EC2Client({ region });
  const findings = [];
  let nextToken;

  do {
    const res = await client.send(
      new DescribeVolumesCommand({
        Filters: [{ Name: "volume-type", Values: ["gp2"] }],
        NextToken: nextToken,
      })
    );

    for (const vol of res.Volumes || []) {
      const savings = Number((vol.Size * SAVINGS_PER_GB).toFixed(2));
      findings.push({
        resourceId: vol.VolumeId,
        region,
        estimatedMonthlyCost: savings,
        details: {
          sizeGb: vol.Size,
          state: vol.State,
          az: vol.AvailabilityZone,
        },
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### gp2 → gp3 Migration Opportunities\n\nNo gp2 volumes found.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const totalGb = findings.reduce((sum, f) => sum + f.details.sizeGb, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] gp2 → gp3 Migration Opportunities`,
    "",
    `**Estimated savings:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} gp2 volume(s) totaling ${totalGb} GB. Migration to gp3 is free, requires no downtime, and saves ~20% per GB.`,
    "",
    "| Volume ID | Size | State | AZ | Savings/mo |",
    "|-----------|------|-------|----|-----------:|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost
  );
  for (const f of sorted.slice(0, 25)) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.sizeGb} GB | ${f.details.state} | ${f.details.az} | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }
  if (sorted.length > 25) {
    lines.push(`| _... and ${sorted.length - 25} more_ | | | | |`);
  }

  lines.push("");
  lines.push("**Fix:** `aws ec2 modify-volume --volume-id VOL_ID --volume-type gp3`. No downtime, no data loss.");
  lines.push("");
  lines.push("**Docs:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-modify-volume.html");

  return lines.join("\n") + "\n";
}
