// Find DynamoDB tables in PROVISIONED billing mode. Most small / low-traffic
// tables are cheaper on PAY_PER_REQUEST — but you keep paying for provisioned
// capacity whether or not you use it.
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";

export const name = "dynamodb_provisioned";

// Provisioned pricing (us-east-1, 2026):
// $0.00065 per WCU-hour, $0.00013 per RCU-hour.
const RCU_COST_PER_MONTH = 0.00013 * 24 * 30;
const WCU_COST_PER_MONTH = 0.00065 * 24 * 30;

export async function run({ region }) {
  const client = new DynamoDBClient({ region });
  const findings = [];
  let exclusiveStartTableName;

  do {
    const list = await client.send(
      new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName })
    );

    for (const tableName of list.TableNames || []) {
      const desc = await client.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = desc.Table;
      if (!table) continue;

      const billing = table.BillingModeSummary?.BillingMode;
      // Tables without BillingModeSummary default to PROVISIONED.
      const isProvisioned = !billing || billing === "PROVISIONED";
      if (!isProvisioned) continue;

      const rcu = table.ProvisionedThroughput?.ReadCapacityUnits || 0;
      const wcu = table.ProvisionedThroughput?.WriteCapacityUnits || 0;
      if (rcu === 0 && wcu === 0) continue; // on-demand without summary set

      const monthlyCost = Number(
        (rcu * RCU_COST_PER_MONTH + wcu * WCU_COST_PER_MONTH).toFixed(2)
      );

      findings.push({
        resourceId: table.TableName,
        region,
        estimatedMonthlyCost: monthlyCost,
        details: {
          rcu,
          wcu,
          itemCount: table.ItemCount,
          tableSizeBytes: table.TableSizeBytes,
        },
      });
    }
    exclusiveStartTableName = list.LastEvaluatedTableName;
  } while (exclusiveStartTableName);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### DynamoDB Provisioned Tables\n\nNo DynamoDB tables in PROVISIONED billing mode.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] DynamoDB Tables on PROVISIONED Billing`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month (baseline capacity cost)`,
    "",
    `${findings.length} DynamoDB table(s) in PROVISIONED mode. For low / bursty traffic, PAY_PER_REQUEST is often cheaper. Review actual consumed capacity in CloudWatch before switching.`,
    "",
    "| Table | RCU | WCU | Items | $/month |",
    "|-------|----:|----:|------:|--------:|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost
  );
  for (const f of sorted) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.rcu} | ${f.details.wcu} | ${f.details.itemCount ?? "—"} | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }

  lines.push("");
  lines.push(
    "**Fix:** If consumed capacity is far below provisioned, switch with `aws dynamodb update-table --table-name NAME --billing-mode PAY_PER_REQUEST`. You can only switch once per 24 hours."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadWriteCapacityMode.html"
  );

  return lines.join("\n") + "\n";
}
