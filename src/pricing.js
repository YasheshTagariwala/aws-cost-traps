// 2026 us-east-1 EBS pricing per GB-month (USD).
// Cross-check with https://aws.amazon.com/ebs/pricing/ — these values shift occasionally.
export const EBS_PRICING_PER_GB_MONTH = {
  gp3: 0.08,
  gp2: 0.10,
  io1: 0.125,
  io2: 0.125,
  st1: 0.045,
  sc1: 0.015,
  standard: 0.05,
};
