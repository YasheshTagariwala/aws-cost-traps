// Find running EC2 instances with very low CPU utilization (likely idle).
// Catches the classic "I forgot this VM was running for months" trap.
import {
  EC2Client,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

export const name = "idle_ec2_instances";

// Rough monthly cost (us-east-1, on-demand Linux) for common instance types.
// Used only when the type isn't in this map — fallback below.
const INSTANCE_COST_PER_MONTH = {
  "t3.nano": 4,
  "t3.micro": 8,
  "t3.small": 15,
  "t3.medium": 30,
  "t3.large": 60,
  "t3.xlarge": 121,
  "t3.2xlarge": 243,
  "t4g.nano": 3,
  "t4g.micro": 6,
  "t4g.small": 12,
  "t4g.medium": 24,
  "t4g.large": 49,
  "m5.large": 70,
  "m5.xlarge": 140,
  "m5.2xlarge": 280,
  "m5.4xlarge": 560,
  "m6i.large": 70,
  "m6i.xlarge": 140,
  "c5.large": 62,
  "c5.xlarge": 124,
  "c6i.large": 62,
  "c6i.xlarge": 124,
  "r5.large": 92,
  "r5.xlarge": 184,
};

const FALLBACK_COST_PER_MONTH = 50;
const CPU_AVG_THRESHOLD = 5;   // %
const CPU_MAX_THRESHOLD = 20;  // %
const LOOKBACK_DAYS = 14;

export async function run({ region }) {
  const ec2 = new EC2Client({ region });
  const cw = new CloudWatchClient({ region });
  const findings = [];
  let nextToken;

  do {
    const res = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: "instance-state-name", Values: ["running"] }],
        NextToken: nextToken,
      })
    );

    const instances = (res.Reservations || []).flatMap((r) => r.Instances || []);

    for (const inst of instances) {
      const end = new Date();
      const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400 * 1000);

      let stats;
      try {
        stats = await cw.send(
          new GetMetricStatisticsCommand({
            Namespace: "AWS/EC2",
            MetricName: "CPUUtilization",
            Dimensions: [{ Name: "InstanceId", Value: inst.InstanceId }],
            StartTime: start,
            EndTime: end,
            Period: 3600,
            Statistics: ["Average", "Maximum"],
          })
        );
      } catch {
        continue;
      }

      const dps = stats.Datapoints || [];
      if (dps.length === 0) continue; // brand new instance, no data — skip

      const avgs = dps.map((d) => d.Average ?? 0);
      const maxs = dps.map((d) => d.Maximum ?? 0);
      const avgCpu = avgs.reduce((a, b) => a + b, 0) / avgs.length;
      const maxCpu = Math.max(...maxs);

      if (avgCpu < CPU_AVG_THRESHOLD && maxCpu < CPU_MAX_THRESHOLD) {
        const type = inst.InstanceType;
        const monthlyCost =
          INSTANCE_COST_PER_MONTH[type] ?? FALLBACK_COST_PER_MONTH;
        const nameTag = (inst.Tags || []).find((t) => t.Key === "Name");

        findings.push({
          resourceId: inst.InstanceId,
          region,
          estimatedMonthlyCost: monthlyCost,
          details: {
            instanceType: type,
            name: nameTag?.Value || "—",
            avgCpu: Number(avgCpu.toFixed(2)),
            maxCpu: Number(maxCpu.toFixed(2)),
            launched: inst.LaunchTime ? inst.LaunchTime.toISOString() : null,
            az: inst.Placement?.AvailabilityZone,
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
    return "### Idle EC2 Instances\n\nNo running EC2 instances with consistently low CPU utilization.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Idle EC2 Instances`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} running EC2 instance(s) averaged <${CPU_AVG_THRESHOLD}% CPU with max <${CPU_MAX_THRESHOLD}% over the last ${LOOKBACK_DAYS} days. Likely forgotten, oversized, or test instances left running.`,
    "",
    "| Instance | Name | Type | Avg CPU | Max CPU | Launched | $/month |",
    "|----------|------|------|--------:|--------:|----------|--------:|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost
  );
  for (const f of sorted) {
    const launched = f.details.launched ? f.details.launched.slice(0, 10) : "—";
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.name} | ${f.details.instanceType} | ${f.details.avgCpu}% | ${f.details.maxCpu}% | ${launched} | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }

  lines.push("");
  lines.push(
    "**Fix:** If truly unused, stop or terminate. If used but oversized, right-size to a smaller instance type. Use AWS Compute Optimizer for recommendations."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html"
  );

  return lines.join("\n") + "\n";
}
