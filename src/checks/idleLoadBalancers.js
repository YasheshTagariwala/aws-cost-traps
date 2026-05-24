// Find ALB/NLB load balancers with zero requests in the last 14 days.
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

export const name = "idle_load_balancers";

// ALB: ~$16/mo idle. NLB: ~$16/mo idle. Use $20 as a round figure.
const COST_PER_IDLE_LB = 20;

const METRIC_BY_TYPE = {
  application: { metric: "RequestCount", namespace: "AWS/ApplicationELB" },
  network: { metric: "ActiveFlowCount", namespace: "AWS/NetworkELB" },
};

export async function run({ region }) {
  const elb = new ElasticLoadBalancingV2Client({ region });
  const cw = new CloudWatchClient({ region });
  const findings = [];
  let marker;

  do {
    const res = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    for (const lb of res.LoadBalancers || []) {
      const config = METRIC_BY_TYPE[lb.Type];
      if (!config) continue; // skip gateway, classic

      // Extract the dimension value: arn looks like
      // arn:aws:elasticloadbalancing:region:acct:loadbalancer/app/name/id
      const arnParts = lb.LoadBalancerArn.split("loadbalancer/");
      if (arnParts.length < 2) continue;
      const dimensionValue = arnParts[1];

      const end = new Date();
      const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);

      const stats = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: config.namespace,
          MetricName: config.metric,
          Dimensions: [{ Name: "LoadBalancer", Value: dimensionValue }],
          StartTime: start,
          EndTime: end,
          Period: 86400, // 1 day
          Statistics: ["Sum"],
        })
      );

      const total = (stats.Datapoints || []).reduce(
        (sum, dp) => sum + (dp.Sum || 0),
        0
      );

      if (total === 0) {
        findings.push({
          resourceId: lb.LoadBalancerName,
          region,
          estimatedMonthlyCost: COST_PER_IDLE_LB,
          details: {
            type: lb.Type,
            scheme: lb.Scheme,
            arn: lb.LoadBalancerArn,
            created: lb.CreatedTime ? lb.CreatedTime.toISOString() : null,
          },
        });
      }
    }
    marker = res.NextMarker;
  } while (marker);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### Idle Load Balancers\n\nNo ALB/NLB load balancers with zero traffic in the last 14 days.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Idle Load Balancers`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} load balancer(s) received zero traffic in the last 14 days but are still running.`,
    "",
    "| Name | Type | Scheme | Created |",
    "|------|------|--------|---------|",
  ];

  for (const f of findings) {
    const created = f.details.created ? f.details.created.slice(0, 10) : "—";
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.type} | ${f.details.scheme} | ${created} |`
    );
  }

  lines.push("");
  lines.push("**Fix:** Delete with `aws elbv2 delete-load-balancer --load-balancer-arn ARN` if truly unused.");
  lines.push("");
  lines.push("**Docs:** https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-delete.html");

  return lines.join("\n") + "\n";
}
