// Find Lambda functions with provisioned concurrency configured.
// Provisioned concurrency keeps containers warm 24/7 — a common cost trap when
// left enabled on dev functions or after traffic patterns changed.
import {
  LambdaClient,
  ListFunctionsCommand,
  ListProvisionedConcurrencyConfigsCommand,
} from "@aws-sdk/client-lambda";

export const name = "lambda_provisioned_concurrency";

// Provisioned Concurrency: $0.0000041667 per GB-second.
// Cost per provisioned execution = memoryGB * 0.0000041667 * 86400 * 30
// Simplifies to: memoryGB * ~10.80/month.
const COST_PER_GB_MONTH = 0.0000041667 * 86400 * 30;

export async function run({ region }) {
  const client = new LambdaClient({ region });
  const findings = [];
  let marker;

  do {
    const fnRes = await client.send(new ListFunctionsCommand({ Marker: marker }));
    for (const fn of fnRes.Functions || []) {
      try {
        const pc = await client.send(
          new ListProvisionedConcurrencyConfigsCommand({
            FunctionName: fn.FunctionName,
          })
        );
        const configs = pc.ProvisionedConcurrencyConfigs || [];
        if (configs.length === 0) continue;

        const memoryGb = (fn.MemorySize || 128) / 1024;
        const totalConcurrency = configs.reduce(
          (sum, c) => sum + (c.AllocatedProvisionedConcurrentExecutions || 0),
          0
        );
        const monthlyCost = Number(
          (totalConcurrency * memoryGb * COST_PER_GB_MONTH).toFixed(2)
        );

        findings.push({
          resourceId: fn.FunctionName,
          region,
          estimatedMonthlyCost: monthlyCost,
          details: {
            memoryMb: fn.MemorySize,
            provisionedConcurrency: totalConcurrency,
            runtime: fn.Runtime,
            qualifiers: configs.map((c) => c.FunctionArn),
          },
        });
      } catch {
        // Function has no provisioned concurrency or insufficient permissions — skip.
      }
    }
    marker = fnRes.NextMarker;
  } while (marker);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### Lambda Provisioned Concurrency\n\nNo Lambda functions with provisioned concurrency. Good — pay only per invocation.\n";
  }

  const total = findings.reduce((sum, f) => sum + f.estimatedMonthlyCost, 0);
  const severity = total > 50 ? "CRITICAL" : "MEDIUM";

  const lines = [
    `### [${severity}] Lambda Functions With Provisioned Concurrency`,
    "",
    `**Estimated cost:** $${total.toFixed(2)}/month`,
    "",
    `${findings.length} function(s) running provisioned concurrency 24/7. Verify each one actually needs cold-start protection.`,
    "",
    "| Function | Memory | Provisioned | Runtime | $/month |",
    "|----------|--------|-------------|---------|---------|",
  ];

  for (const f of findings) {
    lines.push(
      `| \`${f.resourceId}\` | ${f.details.memoryMb} MB | ${f.details.provisionedConcurrency} | ${f.details.runtime} | $${f.estimatedMonthlyCost.toFixed(2)} |`
    );
  }

  lines.push("");
  lines.push(
    "**Fix:** If you don't need sub-50ms cold-start performance, remove with `aws lambda delete-provisioned-concurrency-config --function-name NAME --qualifier QUALIFIER`."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html"
  );

  return lines.join("\n") + "\n";
}
