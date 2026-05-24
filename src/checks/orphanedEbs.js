// Find unattached EBS volumes (state = 'available').
import { EC2Client, DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import { EBS_PRICING_PER_GB_MONTH } from "../pricing.js";

export const name = "orphaned_ebs";

export async function run({ region }) {
  const client = new EC2Client({ region });
  const findings = [];
  let nextToken;

  do {
    const res = await client.send(
      new DescribeVolumesCommand({
        Filters: [{ Name: "status", Values: ["available"] }],
        NextToken: nextToken,
      })
    );

    for (const vol of res.Volumes || []) {
      const sizeGb = vol.Size;
      const volType = vol.VolumeType;
      const costPerGb = EBS_PRICING_PER_GB_MONTH[volType] ?? 0.10;
      const monthlyCost = Number((sizeGb * costPerGb).toFixed(2));

      findings.push({
        resourceId: vol.VolumeId,
        region,
        estimatedMonthlyCost: monthlyCost,
        details: {
          sizeGb,
          volumeType: volType,
          created: vol.CreateTime ? vol.CreateTime.toISOString() : null,
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
    return "### Orphaned EBS Volumes\n\nNo unattached volumes found.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Orphaned EBS Volumes`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} unattached EBS volume(s) found.`,
    "",
    "| Volume ID | Size | Type | Created | $/month |",
    "|-----------|------|------|---------|---------|",
  ];

  for (const f of findings) {
    const created = f.details.created ? f.details.created.slice(0, 10) : "unknown";
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.sizeGb} GB | ${f.details.volumeType} | ${created} | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }

  lines.push("");
  lines.push(
    "**Fix:** Snapshot volumes you might need, then delete the rest with `aws ec2 delete-volume --volume-id VOL_ID`."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-deleting-volume.html"
  );

  return lines.join("\n") + "\n";
}
