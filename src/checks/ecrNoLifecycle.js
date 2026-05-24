// Find ECR repositories without lifecycle policies. These accumulate every
// image build from CI forever — old images at $0.10/GB-month adds up fast.
import {
  ECRClient,
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  ListImagesCommand,
} from "@aws-sdk/client-ecr";

export const name = "ecr_no_lifecycle";

// ECR storage: $0.10/GB-month. We don't fetch sizes (too slow); we count images
// and flag repos with many images + no lifecycle as likely problems.
const IMAGE_COUNT_THRESHOLD = 50;

export async function run({ region }) {
  const client = new ECRClient({ region });
  const findings = [];
  let nextToken;

  do {
    const repos = await client.send(
      new DescribeRepositoriesCommand({ nextToken })
    );

    for (const repo of repos.repositories || []) {
      let hasLifecycle = false;
      try {
        await client.send(
          new GetLifecyclePolicyCommand({ repositoryName: repo.repositoryName })
        );
        hasLifecycle = true;
      } catch (err) {
        if (err.name !== "LifecyclePolicyNotFoundException") {
          continue; // permission issue or other — skip this repo
        }
      }

      if (hasLifecycle) continue;

      // Count images. Cap pagination so a giant repo doesn't blow up the scan.
      let imageCount = 0;
      let imgToken;
      let pages = 0;
      do {
        const imgs = await client.send(
          new ListImagesCommand({
            repositoryName: repo.repositoryName,
            nextToken: imgToken,
          })
        );
        imageCount += (imgs.imageIds || []).length;
        imgToken = imgs.nextToken;
        pages += 1;
      } while (imgToken && pages < 10); // up to ~1000 images, then approximate

      if (imageCount >= IMAGE_COUNT_THRESHOLD) {
        findings.push({
          resourceId: repo.repositoryName,
          region,
          estimatedMonthlyCost: 0, // unknown without GB data
          details: {
            imageCount,
            uri: repo.repositoryUri,
            created: repo.createdAt ? repo.createdAt.toISOString() : null,
          },
        });
      }
    }
    nextToken = repos.nextToken;
  } while (nextToken);

  return findings;
}

export function formatMarkdown(findings) {
  if (findings.length === 0) {
    return "### ECR Repositories Without Lifecycle Rules\n\nAll repositories have lifecycle policies, or none exceed the image-count threshold.\n";
  }

  const lines = [
    `### [INFO] ECR Repositories Without Lifecycle Rules`,
    "",
    `**Estimated cost:** review-only (depends on image sizes)`,
    "",
    `${findings.length} ECR repository(s) with no lifecycle policy and ${IMAGE_COUNT_THRESHOLD}+ images. ECR storage is $0.10/GB-month — old build artifacts compound.`,
    "",
    "| Repository | Images | Created |",
    "|------------|-------:|---------|",
  ];

  const sorted = [...findings].sort(
    (a, b) => b.details.imageCount - a.details.imageCount
  );
  for (const f of sorted) {
    const created = f.details.created ? f.details.created.slice(0, 10) : "—";
    lines.push(`| \`${f.resourceId}\` | ${f.details.imageCount} | ${created} |`);
  }

  lines.push("");
  lines.push(
    "**Fix:** Add a lifecycle policy that keeps the last N tagged images and expires untagged images after 1-7 days. See AWS docs for templates."
  );
  lines.push("");
  lines.push(
    "**Docs:** https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html"
  );

  return lines.join("\n") + "\n";
}
