// Find EBS snapshots older than 180 days. These accumulate silently and many
// are forgotten backups whose source volumes are long gone.
import {
  EC2Client,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";

export const name = "old_ebs_snapshots";

// EBS Snapshot storage: $0.05/GB-month (standard, not Archive).
const SNAPSHOT_COST_PER_GB_MONTH = 0.05;
const AGE_THRESHOLD_DAYS = 180;

export async function run({ region }) {
  const client = new EC2Client({ region });
  const findings = [];
  const cutoff = Date.now() - AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  // First gather existing volume IDs so we can mark "orphaned" snapshots.
  const existingVolumes = new Set();
  let volToken;
  do {
    const vols = await client.send(
      new DescribeVolumesCommand({ NextToken: volToken })
    );
    for (const v of vols.Volumes || []) existingVolumes.add(v.VolumeId);
    volToken = vols.NextToken;
  } while (volToken);

  let nextToken;
  do {
    const res = await client.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ["self"],
        NextToken: nextToken,
      })
    );

    for (const snap of res.Snapshots || []) {
      const startTime = snap.StartTime ? snap.StartTime.getTime() : 0;
      if (startTime > cutoff) continue;

      const sizeGb = snap.VolumeSize || 0;
      const monthlyCost = Number(
        (sizeGb * SNAPSHOT_COST_PER_GB_MONTH).toFixed(2)
      );
      const ageDays = Math.floor((Date.now() - startTime) / 86400000);
      const isOrphaned = !existingVolumes.has(snap.VolumeId);

      findings.push({
        resourceId: snap.SnapshotId,
        region,
        estimatedMonthlyCost: monthlyCost,
        details: {
          sizeGb,
          ageDays,
          isOrphaned,
          sourceVolumeId: snap.VolumeId,
          description: snap.Description || "",
          startTime: snap.StartTime ? snap.StartTime.toISOString() : null,
        },
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return `### Old EBS Snapshots\n\nNo EBS snapshots older than ${AGE_THRESHOLD_DAYS} days.\n`;
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const totalGb = findings.reduce((sum, f) => sum + f.details.sizeGb, 0);
  const orphanedCount = findings.filter((f) => f.details.isOrphaned).length;
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Old EBS Snapshots`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} snapshot(s) older than ${AGE_THRESHOLD_DAYS} days, totaling ${totalGb} GB. ${orphanedCount} are orphaned (source volume deleted).`,
    "",
    "| Snapshot | Size | Age (days) | Orphaned | Description |",
    "|----------|------|-----------:|----------|-------------|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost
  );
  for (const f of sorted.slice(0, 25)) {
    const desc = (f.details.description || "—").slice(0, 50);
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.sizeGb} GB | ${f.details.ageDays} | ${f.details.isOrphaned ? "YES" : "no"} | ${desc} |`
    );
  }
  if (sorted.length > 25) {
    lines.push(`| _... and ${sorted.length - 25} more_ | | | | |`);
  }

  lines.push("");
  lines.push(
    "**Fix:** Review and delete with `aws ec2 delete-snapshot --snapshot-id SNAP_ID`. Orphaned snapshots (source volume deleted) are usually safe to remove. Set up Data Lifecycle Manager for automatic snapshot rotation going forward."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-deleting-snapshot.html"
  );

  return lines.join("\n") + "\n";
}
