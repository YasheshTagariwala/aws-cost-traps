// Flag EKS clusters running on Kubernetes versions in extended support.
// Extended support adds ~$0.60/cluster-hour ≈ $432/month per cluster.
import {
  EKSClient,
  ListClustersCommand,
  DescribeClusterCommand,
} from "@aws-sdk/client-eks";

export const name = "eks_extended_support";

// Kubernetes versions in EKS Extended Support as of mid-2026.
// Update as AWS shifts the standard-support window.
// See: https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
const EXTENDED_SUPPORT_VERSIONS = new Set([
  "1.23",
  "1.24",
  "1.25",
  "1.26",
  "1.27",
  "1.28",
]);

const EXTENDED_SUPPORT_MONTHLY_COST = 432; // $0.60/hr * 24 * 30

export async function run({ region }) {
  const client = new EKSClient({ region });
  const findings = [];
  let nextToken;

  do {
    const list = await client.send(new ListClustersCommand({ nextToken }));
    for (const clusterName of list.clusters || []) {
      const desc = await client.send(
        new DescribeClusterCommand({ name: clusterName })
      );
      const cluster = desc.cluster;
      if (!cluster) continue;

      if (EXTENDED_SUPPORT_VERSIONS.has(cluster.version)) {
        findings.push({
          resourceId: cluster.name,
          region,
          estimatedMonthlyCost: EXTENDED_SUPPORT_MONTHLY_COST,
          details: {
            version: cluster.version,
            status: cluster.status,
            created: cluster.createdAt ? cluster.createdAt.toISOString() : null,
          },
        });
      }
    }
    nextToken = list.nextToken;
  } while (nextToken);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### EKS Extended Support\n\nNo EKS clusters on extended-support Kubernetes versions.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);

  const lines = [
    `### [CRITICAL] EKS Clusters on Extended Support`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month (extra Extended Support fee, on top of normal $73/mo control plane)`,
    "",
    `${findings.length} EKS cluster(s) on Kubernetes versions that have entered Extended Support. AWS charges an additional ~$0.60/cluster-hour ($432/month) until you upgrade.`,
    "",
    "| Cluster | K8s Version | Status | Created |",
    "|---------|-------------|--------|---------|",
  ];

  for (const f of findings) {
    const created = f.details.created ? f.details.created.slice(0, 10) : "—";
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.version} | ${f.details.status} | ${created} |`
    );
  }

  lines.push("");
  lines.push(
    "**Fix:** Upgrade Kubernetes version step-by-step (one minor version at a time). Test workloads in a non-prod cluster first."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html"
  );

  return lines.join("\n") + "\n";
}
