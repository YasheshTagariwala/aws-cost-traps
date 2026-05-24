// Find EBS volumes paying for provisioned IOPS / throughput beyond the free
// baseline. gp3 includes 3,000 IOPS and 125 MB/s free; anything above bills
// separately. io1/io2 bill for every provisioned IOPS. This cost does NOT
// appear as "GB stored" — it is a common cause of an EBS bill that climbs
// for no obvious reason. (See the r/aws "EBS Cost skyrocketing" thread.)
import { EC2Client, DescribeVolumesCommand } from "@aws-sdk/client-ec2";

export const name = "ebs_provisioned_iops";

// us-east-1 pricing, 2026.
const GP3_FREE_IOPS = 3000;
const GP3_FREE_THROUGHPUT = 125; // MB/s
const GP3_IOPS_COST = 0.005; // per provisioned IOPS-month above 3,000
const GP3_THROUGHPUT_COST = 0.04; // per provisioned MB/s-month above 125
const IO_IOPS_COST = 0.065; // io1/io2 per provisioned IOPS-month (first tier)

export async function run({ region }) {
  const client = new EC2Client({ region });
  const findings = [];
  let nextToken;

  do {
    const res = await client.send(
      new DescribeVolumesCommand({ NextToken: nextToken })
    );

    for (const vol of res.Volumes || []) {
      const type = vol.VolumeType;
      const iops = vol.Iops || 0;
      const throughput = vol.Throughput || 0;
      let extraCost = 0;
      const reasons = [];

      if (type === "gp3") {
        const extraIops = Math.max(0, iops - GP3_FREE_IOPS);
        const extraTput = Math.max(0, throughput - GP3_FREE_THROUGHPUT);
        if (extraIops > 0) {
          extraCost += extraIops * GP3_IOPS_COST;
          reasons.push(`${extraIops} IOPS above the free 3,000`);
        }
        if (extraTput > 0) {
          extraCost += extraTput * GP3_THROUGHPUT_COST;
          reasons.push(`${extraTput} MB/s above the free 125`);
        }
      } else if (type === "io1" || type === "io2") {
        if (iops > 0) {
          extraCost += iops * IO_IOPS_COST;
          reasons.push(`${iops} provisioned IOPS (${type})`);
        }
      }

      if (extraCost > 0) {
        findings.push({
          resourceId: vol.VolumeId,
          region,
          estimatedMonthlyCost: Number(extraCost.toFixed(2)),
          details: {
            volumeType: type,
            sizeGb: vol.Size,
            iops,
            throughput,
            state: vol.State,
            reasons,
          },
        });
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### EBS Provisioned IOPS / Throughput\n\nNo volumes paying for IOPS or throughput beyond the free baseline.\n";
  }

  const total = findings.reduce((s, f) => s + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] EBS Provisioned IOPS / Throughput`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} volume(s) billing for provisioned IOPS or throughput on top of raw storage. This cost is invisible in "GB stored" and is a common cause of an EBS bill that climbs with no obvious reason.`,
    "",
    "| Volume ID | Type | Size | IOPS | Throughput | Extra $/month |",
    "|-----------|------|------|-----:|-----------:|--------------:|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost
  );
  for (const f of sorted) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.volumeType} | ${f.details.sizeGb} GB | ${f.details.iops} | ${f.details.throughput} MB/s | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }

  lines.push("");
  lines.push(
    "**Fix:** For gp3, drop provisioned IOPS/throughput to the free baseline (3,000 IOPS / 125 MB/s) if the workload doesn't need more: `aws ec2 modify-volume --volume-id VOL_ID --iops 3000 --throughput 125`. For io1/io2 with high IOPS, confirm the workload genuinely needs that tier."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html"
  );

  return lines.join("\n") + "\n";
}
