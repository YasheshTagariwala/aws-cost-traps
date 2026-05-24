// Pull spend from the AWS Cost Explorer API and detect spend anomalies.
//
// ONE call does everything: DAILY granularity grouped by SERVICE + RECORD_TYPE.
// From that single response we derive:
//   - the 30-day summary (gross usage, credits, net, by-service)
//   - per-service daily trends, used for anomaly detection
//
// Anomaly detection compares each service's recent daily average against its
// prior baseline average. A sudden spike (e.g. Bedrock $0 -> $14k, or EBS
// creeping up day over day) is the single most useful thing to surface.
//
// Cost Explorer is account-wide and global — endpoint is always us-east-1.
// GetCostAndUsage costs $0.01 per request; this makes ONE.
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

export const name = "cost_summary";

const NON_USAGE_RECORD_TYPES = new Set(["Credit", "Refund"]);

// Anomaly detection tuning.
const RECENT_DAYS = 3; // most recent N complete days = "current"
const BASELINE_DAYS = 21; // the N days before that = "normal"
const SPIKE_MULTIPLIER = 3; // recent must exceed baseline by this factor
const MIN_DAILY_DELTA = 1.0; // ignore jumps smaller than $1/day (noise)

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export async function run() {
  const client = new CostExplorerClient({ region: "us-east-1" });

  const today = new Date();
  const totalDays = RECENT_DAYS + BASELINE_DAYS + 3; // small buffer
  const start = new Date(today.getTime() - totalDays * 86400 * 1000);
  const period = { Start: ymd(start), End: ymd(today) };

  const res = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: period,
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "RECORD_TYPE" },
      ],
    })
  );

  const byService = new Map();
  const byRecordType = new Map();
  const dailyByService = new Map(); // service -> Map(date -> cost)
  let grossUsage = 0;
  let currency = "USD";

  const buckets = res.ResultsByTime || [];
  for (const bucket of buckets) {
    const date = bucket.TimePeriod?.Start;
    for (const group of bucket.Groups || []) {
      const service = group.Keys?.[0] || "Unknown";
      const recordType = group.Keys?.[1] || "Unknown";
      const metric = group.Metrics?.UnblendedCost;
      if (!metric) continue;

      const amount = parseFloat(metric.Amount || "0");
      currency = metric.Unit || currency;

      byRecordType.set(
        recordType,
        (byRecordType.get(recordType) || 0) + amount
      );

      if (!NON_USAGE_RECORD_TYPES.has(recordType)) {
        byService.set(service, (byService.get(service) || 0) + amount);
        grossUsage += amount;

        if (!dailyByService.has(service)) dailyByService.set(service, new Map());
        const dayMap = dailyByService.get(service);
        dayMap.set(date, (dayMap.get(date) || 0) + amount);
      }
    }
  }

  const credits = byRecordType.get("Credit") || 0;
  const netCost = [...byRecordType.values()].reduce((a, b) => a + b, 0);

  const services = [...byService.entries()]
    .map(([service, cost]) => ({ service, cost }))
    .sort((a, b) => b.cost - a.cost);

  const recordTypes = [...byRecordType.entries()]
    .map(([type, amount]) => ({ type, amount }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // --- Anomaly detection ---
  const allDates = [
    ...new Set(buckets.map((b) => b.TimePeriod?.Start).filter(Boolean)),
  ].sort();
  const recentDates = allDates.slice(-RECENT_DAYS);
  const baselineDates = allDates.slice(
    -(RECENT_DAYS + BASELINE_DAYS),
    -RECENT_DAYS
  );

  const anomalies = [];
  for (const [service, dayMap] of dailyByService) {
    const recentTotal = recentDates.reduce(
      (s, d) => s + (dayMap.get(d) || 0),
      0
    );
    const baselineTotal = baselineDates.reduce(
      (s, d) => s + (dayMap.get(d) || 0),
      0
    );
    const recentAvg = recentDates.length
      ? recentTotal / recentDates.length
      : 0;
    const baselineAvg = baselineDates.length
      ? baselineTotal / baselineDates.length
      : 0;

    const delta = recentAvg - baselineAvg;
    if (delta < MIN_DAILY_DELTA) continue;

    const isSpike =
      baselineAvg < 0.01
        ? recentAvg >= MIN_DAILY_DELTA // brand-new service appeared
        : recentAvg >= baselineAvg * SPIKE_MULTIPLIER;

    if (isSpike) {
      anomalies.push({
        service,
        recentAvg,
        baselineAvg,
        deltaPerDay: delta,
        projectedMonthlyImpact: delta * 30,
        isNew: baselineAvg < 0.01,
      });
    }
  }
  anomalies.sort((a, b) => b.deltaPerDay - a.deltaPerDay);

  return {
    grossUsage,
    credits,
    netCost,
    currency,
    services,
    recordTypes,
    anomalies,
    periodStart: ymd(start),
    periodEnd: ymd(today),
    recentDays: RECENT_DAYS,
    baselineDays: BASELINE_DAYS,
  };
}

export function formatMarkdown(summary) {
  const c = summary.currency;
  const lines = [];

  // --- Anomalies first: most urgent thing in the whole report ---
  lines.push("## Spend Anomalies (sudden cost jumps)");
  lines.push("");
  if (summary.anomalies.length === 0) {
    lines.push(
      `No service spiked in the last ${summary.recentDays} days versus the prior ${summary.baselineDays}-day baseline.`
    );
    lines.push("");
  } else {
    lines.push(
      `${summary.anomalies.length} service(s) spiked in the last ${summary.recentDays} days vs the prior ${summary.baselineDays}-day baseline. **Investigate these first** — a spike usually means a new workload, a misconfiguration, or leaked credentials.`
    );
    lines.push("");
    lines.push(
      "| Service | Baseline $/day | Recent $/day | Extra $/day | ~30-day impact |"
    );
    lines.push(
      "|---------|---------------:|-------------:|------------:|---------------:|"
    );
    for (const a of summary.anomalies) {
      const label = a.isNew ? ` (new)` : "";
      lines.push(
        `| ${a.service}${label} | $${a.baselineAvg.toFixed(2)} | $${a.recentAvg.toFixed(2)} | +$${a.deltaPerDay.toFixed(2)} | +$${a.projectedMonthlyImpact.toFixed(2)} |`
      );
    }
    lines.push("");
  }

  // --- Summary ---
  lines.push("## Spend Summary (last 30 days, whole account)");
  lines.push("");
  lines.push(`_Period: ${summary.periodStart} to ${summary.periodEnd}_`);
  lines.push("");
  lines.push(`- **Gross usage cost:** $${summary.grossUsage.toFixed(2)} ${c}`);
  lines.push(`- **Credits applied:** $${summary.credits.toFixed(2)} ${c}`);
  lines.push(
    `- **Net cost (what you actually pay):** $${summary.netCost.toFixed(2)} ${c}`
  );
  lines.push("");

  if (summary.recordTypes.length > 1) {
    lines.push("### Breakdown by Record Type");
    lines.push("");
    lines.push("| Record Type | Amount |");
    lines.push("|-------------|-------:|");
    for (const r of summary.recordTypes) {
      lines.push(`| ${r.type} | $${r.amount.toFixed(2)} |`);
    }
    lines.push("");
  }

  const visible = summary.services.filter((s) => s.cost >= 0.01);
  lines.push("### Gross Usage by Service");
  lines.push("");
  if (visible.length === 0) {
    lines.push("_No billable usage in this period._");
  } else {
    lines.push("| Service | Cost | Share |");
    lines.push("|---------|-----:|------:|");
    for (const s of visible) {
      const pct =
        summary.grossUsage > 0 ? (s.cost / summary.grossUsage) * 100 : 0;
      lines.push(
        `| ${s.service} | $${s.cost.toFixed(2)} | ${pct.toFixed(1)}% |`
      );
    }
  }
  lines.push("");

  return lines.join("\n") + "\n";
}
