// Flag RDS instances likely on AWS RDS Extended Support pricing.
// Extended Support adds $0.100/vCPU-hour after community EOL — can double DB cost.
import {
  RDSClient,
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";

export const name = "rds_extended_support";

// Engine versions that have entered (or are nearing) Extended Support.
// Sources: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support.html
// Update this map as AWS publishes new EOL dates.
const EXTENDED_SUPPORT_VERSIONS = {
  mysql: ["5.7"],
  "aurora-mysql": ["2"], // Aurora MySQL 2.x maps to MySQL 5.7
  postgres: ["11", "12"],
  "aurora-postgresql": ["11", "12"],
  mariadb: ["10.4", "10.5"],
};

// Rough estimate per instance. AWS charges per vCPU-hour but we don't have
// vCPU count cheaply — assume 2 vCPU as a conservative baseline = $144/month.
const ESTIMATED_MONTHLY_COST_PER_INSTANCE = 144;

function isExtendedSupport(engine, engineVersion) {
  const flagged = EXTENDED_SUPPORT_VERSIONS[engine] || [];
  return flagged.some((v) => engineVersion.startsWith(v));
}

export async function run({ region }) {
  const client = new RDSClient({ region });
  const findings = [];
  let marker;

  do {
    const res = await client.send(new DescribeDBInstancesCommand({ Marker: marker }));
    for (const db of res.DBInstances || []) {
      if (isExtendedSupport(db.Engine, db.EngineVersion)) {
        findings.push({
          resourceId: db.DBInstanceIdentifier,
          region,
          estimatedMonthlyCost: ESTIMATED_MONTHLY_COST_PER_INSTANCE,
          details: {
            engine: db.Engine,
            engineVersion: db.EngineVersion,
            instanceClass: db.DBInstanceClass,
            status: db.DBInstanceStatus,
          },
        });
      }
    }
    marker = res.Marker;
  } while (marker);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### RDS Extended Support Charges\n\nNo RDS instances on engine versions likely subject to Extended Support pricing.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);

  const lines = [
    `### [CRITICAL] RDS Instances on Extended Support`,
    "",
    `**Estimated cost:** ~$${total.toFixed(2)}/month (rough estimate based on 2 vCPU baseline; actual cost scales with vCPU)`,
    "",
    `${findings.length} RDS instance(s) running an engine version that has reached Extended Support. AWS charges $0.100/vCPU-hour on top of normal cost — this can double your DB bill silently.`,
    "",
    "| Instance | Engine | Version | Class |",
    "|----------|--------|---------|-------|",
  ];

  for (const f of findings) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.engine} | ${f.details.engineVersion} | ${f.details.instanceClass} |`
    );
  }

  lines.push("");
  lines.push("**Fix:** Upgrade the engine to a supported major version. Test in staging first — this can be a multi-week effort for production DBs.");
  lines.push("");
  lines.push("**Docs:** https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support.html");

  return lines.join("\n") + "\n";
}
