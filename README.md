# aws-cost-traps

A free, read-only CLI that scans an AWS account for 15 common cost traps, detects sudden spend spikes, and writes a single Markdown report.

No signup. No data leaves your machine. MIT licensed.

## Why

AWS's Cost Anomaly Detection catches spikes. It doesn't catch the slow, legitimate-but-invisible line items — unattached EIPs accruing $3.60/month each since Feb 2024, NAT Gateways processing S3 traffic that should be free via Gateway Endpoints, RDS instances on engine versions that quietly entered Extended Support, EBS snapshots from volumes that were deleted years ago, EKS clusters on extended-support Kubernetes paying $432/month extra.

This CLI runs locally against your account with a strict read-only IAM policy and produces a Markdown report you can read, diff between scans, or paste into a ticket.

## Spend anomaly detection

Every run also pulls daily spend per service and flags any service whose recent
daily average has spiked against its prior baseline — catching sudden jumps
(a new workload, a misconfiguration, or leaked credentials) that a snapshot
scan alone would miss.

## Checks

| # | Check | Service |
|---|-------|---------|
| 1 | `orphaned_ebs` | Unattached EBS volumes |
| 2 | `ebs_provisioned_iops` | EBS volumes paying for IOPS/throughput above the free baseline |
| 3 | `idle_public_ipv4` | Unassociated Elastic IPs |
| 4 | `nat_missing_endpoints` | NAT Gateways without free S3/DynamoDB Gateway Endpoints |
| 5 | `cloudwatch_no_retention` | Log groups storing data forever |
| 6 | `rds_extended_support` | RDS on MySQL 5.7, Postgres 11/12, Aurora MySQL 2.x, MariaDB 10.4/10.5 |
| 7 | `idle_load_balancers` | ALB/NLB with zero traffic in 14 days |
| 8 | `gp2_volumes` | gp2 volumes that should be gp3 (free 20% savings) |
| 9 | `s3_no_lifecycle` | Buckets without lifecycle rules |
| 10 | `lambda_provisioned_concurrency` | Lambda functions with provisioned concurrency 24/7 |
| 11 | `eks_extended_support` | EKS clusters on extended-support K8s versions |
| 12 | `old_ebs_snapshots` | Snapshots older than 180 days (orphans flagged separately) |
| 13 | `ecr_no_lifecycle` | ECR repos accumulating images with no cleanup policy |
| 14 | `dynamodb_provisioned` | DynamoDB tables on PROVISIONED billing mode |
| 15 | `idle_ec2_instances` | Running EC2 instances with <5% avg CPU over 14 days |

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/aws-cost-traps.git
cd aws-cost-traps
npm install
node src/cli.js --region us-east-1
```

You'll need AWS credentials configured first — see the setup below.

## AWS setup (one-time)

The scanner only makes read-only calls. The steps below create a dedicated IAM
user whose credentials can do nothing but `Describe*` / `Get*` / `List*`.

### Step 1 — Create the read-only policy

1. AWS Console → search **IAM** → open it.
2. Left menu → **Policies** → **Create policy**.
3. Click the **JSON** tab, clear it, and paste the entire contents of
   [`iam-policy.json`](./iam-policy.json).
4. **Next** → Policy name: `CostTrapScannerReadOnly` → **Create policy**.

### Step 2 — Create a user for the scanner

1. IAM → **Users** → **Create user**.
2. Username: `cost-trap-scanner`.
3. Leave "Provide user access to the AWS Management Console" **unchecked** —
   this user is for the CLI only.
4. **Next**.

### Step 3 — Attach the policy

1. Choose **Attach policies directly**.
2. Search `CostTrapScannerReadOnly` and tick its checkbox.
3. **Next** → **Create user**.

### Step 4 — Create an access key

1. Open the new `cost-trap-scanner` user → **Security credentials** tab.
2. Under **Access keys**, click **Create access key**.
3. Use case: **Command Line Interface (CLI)** → tick the acknowledgement →
   **Next** → **Create access key**.
4. Copy the **Access key ID** and **Secret access key** now. The secret is
   shown only once.

### Step 5 — Configure credentials with a `.env` file

Copy the example file and fill in the keys from Step 4:

```bash
cp .env.example .env
```

Then edit `.env`:

```
AWS_ACCESS_KEY_ID=your_access_key_id_here
AWS_SECRET_ACCESS_KEY=your_secret_access_key_here
AWS_REGION=ap-south-1
```

The CLI loads this automatically. `.env` is gitignored — it is never committed.

Other options if you prefer:
- `aws configure` (writes to `~/.aws/credentials`).
- Exporting `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in your shell.
- An IAM role attached to an EC2 instance — no keys needed if you run it there.

### Step 6 — Run

```bash
node src/cli.js
```

With `AWS_REGION` set in `.env`, no `--region` flag is needed. To scan a
different region, override it:

```bash
node src/cli.js --region us-east-1
```

## Usage

```bash
# Scan everything in a region
node src/cli.js --region us-east-1

# List all available checks
node src/cli.js --list-checks

# Run only specific checks
node src/cli.js --region us-east-1 --only orphaned_ebs,gp2_volumes,idle_ec2_instances

# Custom output path
node src/cli.js --region us-east-1 --output ./reports/scan.md
```

Output: `cost-trap-report-<account>-<date>.md` with total estimated monthly waste at the top and per-check sections below.

## What the report looks like

```markdown
# AWS Cost Trap Report
**Account:** 123456789012
**Region scanned:** ap-south-1
**Scan date:** 2026-05-16
**Last 30 days spend (whole account):** $1,240.55 USD
**Estimated monthly waste found:** $487.23

---

## Spend by Service (last 30 days, whole account)
**Total:** $1,240.55 USD  (2026-04-16 to 2026-05-16)
| Service | Cost | Share |
|---------|-----:|------:|
| Amazon EC2 | $610.20 | 49.2% |
| Amazon RDS | $312.40 | 25.2% |
| Amazon S3 | $140.10 | 11.3% |
| ...

---

## Cost Trap Findings

### [CRITICAL] Missing VPC Gateway Endpoints (NAT waste)
**Estimated cost:** $320.00/month
...

### [CRITICAL] Orphaned EBS Volumes
**Estimated cost:** $63.00/month
...
```

Each finding includes the fix command and a docs link. The spend summary is
account-wide (Cost Explorer is not region-scoped); the trap findings are for
the scanned region only.

## Limitations

- Scans one region at a time. Re-run per region you use.
- Cost estimates are based on us-east-1 published pricing. Actual costs vary by region.
- A few checks (S3 lifecycle, ECR lifecycle) are informational — they flag patterns commonly associated with waste but can't compute exact dollar impact without crawling content.
- Extended-support version lists for RDS / EKS are hardcoded and need periodic updates as AWS shifts standard-support windows.
- The spend summary needs Cost Explorer enabled (Billing console → Cost Explorer). Each Cost Explorer API call costs $0.01 — the scanner makes one per run.

## IAM policy

The full policy is in [`iam-policy.json`](./iam-policy.json). All actions are `Describe*` / `Get*` / `List*` — no write permissions of any kind.

## License

MIT.

## Contributing

Issues and PRs welcome. Especially:
- New checks (Redshift, Aurora Serverless v2, RDS allocated-but-unused storage, OpenSearch, MSK, Transit Gateway, FSx, Backup vaults).
- Multi-region scans in one command.
- Better cost estimation per region.
