#!/usr/bin/env node
import "dotenv/config"; // loads AWS_* vars from .env if present
import { Command } from "commander";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { writeFileSync } from "node:fs";

import * as orphanedEbs from "./checks/orphanedEbs.js";
import * as ebsProvisionedIops from "./checks/ebsProvisionedIops.js";
import * as idlePublicIpv4 from "./checks/idlePublicIpv4.js";
import * as natMissingEndpoints from "./checks/natMissingEndpoints.js";
import * as cloudwatchNoRetention from "./checks/cloudwatchNoRetention.js";
import * as rdsExtendedSupport from "./checks/rdsExtendedSupport.js";
import * as idleLoadBalancers from "./checks/idleLoadBalancers.js";
import * as gp2Volumes from "./checks/gp2Volumes.js";
import * as s3NoLifecycle from "./checks/s3NoLifecycle.js";
import * as lambdaProvisionedConcurrency from "./checks/lambdaProvisionedConcurrency.js";
import * as eksExtendedSupport from "./checks/eksExtendedSupport.js";
import * as oldEbsSnapshots from "./checks/oldEbsSnapshots.js";
import * as ecrNoLifecycle from "./checks/ecrNoLifecycle.js";
import * as dynamodbProvisioned from "./checks/dynamodbProvisioned.js";
import * as idleEc2Instances from "./checks/idleEc2Instances.js";
import * as costSummary from "./costSummary.js";

const checks = [
  orphanedEbs,
  ebsProvisionedIops,
  idlePublicIpv4,
  natMissingEndpoints,
  cloudwatchNoRetention,
  rdsExtendedSupport,
  idleLoadBalancers,
  gp2Volumes,
  s3NoLifecycle,
  lambdaProvisionedConcurrency,
  eksExtendedSupport,
  oldEbsSnapshots,
  ecrNoLifecycle,
  dynamodbProvisioned,
  idleEc2Instances,
];

const program = new Command();

program
  .name("aws-cost-traps")
  .description("Scan an AWS account for common cost traps. Produces a Markdown report.")
  .option(
    "--region <region>",
    "AWS region to scan (defaults to AWS_REGION from .env)",
    process.env.AWS_REGION || "us-east-1"
  )
  .option("--output <path>", "Output Markdown file path")
  .option("--only <names>", "Comma-separated list of checks to run (default: all)")
  .option("--list-checks", "List all available checks and exit")
  .action(async (opts) => {
    if (opts.listChecks) {
      for (const c of checks) console.log(c.name);
      return;
    }

    const sts = new STSClient({ region: opts.region });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;
    const today = new Date().toISOString().slice(0, 10);
    const outputPath =
      opts.output || `./cost-trap-report-${accountId}-${today}.md`;

    const selected = opts.only
      ? new Set(opts.only.split(",").map((s) => s.trim()))
      : null;
    const toRun = selected ? checks.filter((c) => selected.has(c.name)) : checks;

    const header = [
      "# AWS Cost Trap Report",
      "",
      `**Account:** ${accountId}`,
      `**Region scanned:** ${opts.region}`,
      `**Scan date:** ${today}`,
    ];

    // Cost summary (account-wide, via Cost Explorer).
    let costSection = "";
    process.stdout.write("Fetching cost summary... ");
    try {
      const summary = await costSummary.run();
      costSection = costSummary.formatMarkdown(summary);
      header.push(
        `**Last 30 days — gross usage:** $${summary.grossUsage.toFixed(2)} ${summary.currency}  |  ` +
          `credits: $${summary.credits.toFixed(2)}  |  ` +
          `net: $${summary.netCost.toFixed(2)}`
      );
      if (summary.anomalies.length > 0) {
        header.push(
          `**Spend anomalies detected:** ${summary.anomalies.length} service(s) spiking — see Spend Anomalies section.`
        );
      }
      console.log(
        `gross $${summary.grossUsage.toFixed(2)}, net $${summary.netCost.toFixed(2)}, ${summary.anomalies.length} anomaly(ies)`
      );
    } catch (err) {
      costSection =
        `## Spend by Service\n\n_Could not fetch cost data: ${err.message}_\n\n` +
        "_Make sure Cost Explorer is enabled (Billing console → Cost Explorer) " +
        "and the IAM policy includes `ce:GetCostAndUsage`._\n";
      console.log(`failed (${err.message})`);
    }

    let totalWaste = 0;
    const checkOutputs = [];

    for (const check of toRun) {
      process.stdout.write(`Running ${check.name}... `);
      try {
        const findings = await check.run({ region: opts.region });
        const waste = findings.reduce(
          (s, f) => s + f.estimatedMonthlyCost,
          0
        );
        totalWaste += waste;
        checkOutputs.push(check.formatMarkdown(findings));
        console.log(`${findings.length} found ($${waste.toFixed(2)}/mo)`);
      } catch (err) {
        checkOutputs.push(
          `### ${check.name}\n\n_Check failed: ${err.message}_\n`
        );
        console.log(`failed (${err.message})`);
      }
    }

    const sections = [
      ...header,
      `**Estimated monthly waste found:** $${totalWaste.toFixed(2)}`,
      "",
      "---",
      "",
      costSection,
      "---",
      "",
      "## Cost Trap Findings",
      "",
      ...checkOutputs,
    ];

    writeFileSync(outputPath, sections.join("\n"));
    console.log(`\nReport saved to ${outputPath}`);
    console.log(`Estimated monthly waste: $${totalWaste.toFixed(2)}`);
  });

program.parseAsync().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
