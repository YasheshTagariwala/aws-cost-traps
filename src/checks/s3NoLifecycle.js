// Find S3 buckets without lifecycle rules.
// Buckets without lifecycle policies often accumulate: old versions, incomplete
// multipart uploads, and objects that should have moved to cheaper storage tiers.
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
} from "@aws-sdk/client-s3";

export const name = "s3_no_lifecycle";

// Informational only — we can't estimate cost without crawling bucket contents.
// But buckets without lifecycle rules are a known cost-leak pattern.
const ESTIMATED_FLAG_VALUE = 0;

export async function run({ region }) {
  // S3 ListBuckets is global; we filter by region after.
  const client = new S3Client({ region });
  const findings = [];

  const list = await client.send(new ListBucketsCommand({}));
  for (const bucket of list.Buckets || []) {
    let bucketRegion = region;
    try {
      const loc = await client.send(
        new GetBucketLocationCommand({ Bucket: bucket.Name })
      );
      // LocationConstraint is null for us-east-1.
      bucketRegion = loc.LocationConstraint || "us-east-1";
    } catch {
      continue;
    }

    if (bucketRegion !== region) continue;

    try {
      await client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket.Name })
      );
      // Has lifecycle — fine.
    } catch (err) {
      if (err.name === "NoSuchLifecycleConfiguration") {
        findings.push({
          resourceId: bucket.Name,
          region,
          estimatedMonthlyCost: ESTIMATED_FLAG_VALUE,
          details: {
            created: bucket.CreationDate
              ? bucket.CreationDate.toISOString()
              : null,
          },
        });
      }
    }
  }

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### S3 Buckets Without Lifecycle Rules\n\nAll buckets in this region have lifecycle policies.\n";
  }

  const lines = [
    `### [INFO] S3 Buckets Without Lifecycle Rules`,
    "",
    `**Estimated cost:** review-only (depends on bucket contents)`,
    "",
    `${findings.length} S3 bucket(s) without any lifecycle rule. Common leaks: incomplete multipart uploads accumulating silently, old object versions never expiring, hot-tier storage for cold data.`,
    "",
    "| Bucket | Created |",
    "|--------|---------|",
  ];

  for (const f of findings) {
    const created = f.details.created ? f.details.created.slice(0, 10) : "—";
    lines.push(`| \`${f.resourceId}\` | ${created} |`);
  }

  lines.push("");
  lines.push(
    "**Fix:** Add lifecycle rules to abort incomplete multipart uploads after 7 days, expire non-current versions after 30/90 days, transition cold objects to IA/Glacier."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html"
  );

  return lines.join("\n") + "\n";
}
