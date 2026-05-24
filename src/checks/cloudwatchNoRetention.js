// Find CloudWatch log groups with no retention policy (logs kept forever).
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

export const name = "cloudwatch_no_retention";

// CloudWatch Logs Standard storage: $0.03/GB/month.
const STORAGE_COST_PER_GB_MONTH = 0.03;

export async function run({ region }) {
  const client = new CloudWatchLogsClient({ region });
  const findings = [];
  let nextToken;

  do {
    const res = await client.send(
      new DescribeLogGroupsCommand({ nextToken })
    );

    for (const lg of res.logGroups || []) {
      if (lg.retentionInDays == null) {
        const storedGb = (lg.storedBytes || 0) / (1024 ** 3);
        const monthlyCost = Number((storedGb * STORAGE_COST_PER_GB_MONTH).toFixed(2));
        findings.push({
          resourceId: lg.logGroupName,
          region,
          estimatedMonthlyCost: monthlyCost,
          details: {
            storedGb: Number(storedGb.toFixed(3)),
            created: lg.creationTime
              ? new Date(lg.creationTime).toISOString()
              : null,
          },
        });
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### CloudWatch Log Groups Without Retention\n\nAll log groups have a retention policy set.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const totalGb = findings.reduce((sum, f) => sum + f.details.storedGb, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] CloudWatch Log Groups Without Retention`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month (storage only; ingestion cost is separate)`,
    "",
    `${findings.length} log group(s) with no retention policy, storing ${totalGb.toFixed(2)} GB total. Logs are kept forever and will grow indefinitely.`,
    "",
    "| Log Group | Stored | $/month |",
    "|-----------|--------|---------|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost
  );
  for (const f of sorted.slice(0, 25)) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.storedGb.toFixed(2)} GB | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }
  if (sorted.length > 25) {
    lines.push(`| _... and ${sorted.length - 25} more_ | | |`);
  }

  lines.push("");
  lines.push("**Fix:** Set retention with `aws logs put-retention-policy --log-group-name NAME --retention-in-days 30`.");
  lines.push("");
  lines.push("**Docs:** https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SettingLogRetention.html");

  return lines.join("\n") + "\n";
}
