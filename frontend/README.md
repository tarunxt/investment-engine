This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Polymarket Bot

The dashboard now includes a native `Polymarket Bot` module at `/console/polymarket-bot`.

Safe defaults:

- `PAPER_TRADING=true`
- `LIVE_TRADING=false`
- `USE_LIVE_READS=false`
- `AUTO_EXECUTE_LIVE=false`
- `REQUIRE_MANUAL_CONFIRMATION=true`
- `LIVE_UNLOCK_MODE=automatic`

Persistent bot files are stored outside `public/` under `POLYMARKET_DATA_DIR` (default: `data/polymarket`) and are created per authenticated user:

- `polymarket-trades.json`
- `polymarket-live-trades.json`
- `polymarket-bot.log`
- `polymarket-errors.log`

The backend integration only uses Bullpen through explicit subprocess execution. No live order is placed unless a user confirms an existing pending trade from the dashboard.

The backend Docker image now installs the Bullpen CLI, so `Refresh doctor`, balance refresh, and live reads no longer depend on a host-machine-only Bullpen binary. Bullpen credentials still need to exist inside the backend runtime for authenticated checks to pass.

## Platform Cost Drivers dashboard

The Settings tab **Platform Cost Drivers** (`/console/profile/cost-drivers`) is an admin-only, read-only cost observability dashboard for Cred-x. It combines delayed AWS billing actuals with near-real-time infrastructure and website bandwidth attribution so administrators can tell whether spend is coming from data transfer, EC2 runtime, EBS, public IPv4, logs, Transfer Family, NAT/ALB, images, videos, API JSON, JavaScript bundles, HTML pages, or bots.

### Server-side AWS configuration

AWS credentials must never be exposed to the browser. Configure credentials only for the backend container or use the EC2 instance/IAM role attached to the server:

```bash
AWS_REGION=ap-south-1
AWS_COST_REGION=us-east-1
COST_DASHBOARD_ADMIN_EMAILS=admin@example.com
COST_DASHBOARD_CACHE_TTL_SECONDS=3600
COST_DASHBOARD_MOCK_MODE=false
# Optional, server-only if no IAM role is available:
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Optional estimator overrides:

```bash
DATA_TRANSFER_OUT_RATE_PER_GB=0.09
EBS_GP3_RATE_PER_GB_MONTH=0.08
PUBLIC_IPV4_RATE_PER_HOUR=0.005
CLOUDWATCH_LOG_INGEST_RATE_PER_GB=0.50
CLOUDWATCH_LOG_STORAGE_RATE_PER_GB_MONTH=0.03
```

### Required read-only IAM permissions

Grant only read/list permissions. The dashboard does not delete or modify AWS resources.

- `ce:GetCostAndUsage`
- `ce:GetCostForecast`
- `ce:GetDimensionValues`
- `cloudwatch:GetMetricData`
- `cloudwatch:ListMetrics`
- `ec2:DescribeInstances`
- `ec2:DescribeVolumes`
- `ec2:DescribeSnapshots`
- `ec2:DescribeAddresses`
- `ec2:DescribeNatGateways`
- `logs:DescribeLogGroups`
- `elasticloadbalancing:DescribeLoadBalancers`
- `elasticloadbalancing:DescribeTargetGroups`
- `transfer:ListServers`
- `s3:ListAllMyBuckets`
- `s3:GetBucketLocation`
- `cloudfront:ListDistributions`
- `route53:ListHostedZones`
- `pricing:GetProducts` (optional)

### Refresh cadence and data freshness

- Dashboard responses are cached server-side. `COST_DASHBOARD_CACHE_TTL_SECONDS` defaults to `3600` seconds.
- The **Refresh now** button is admin-only and rate-limited.
- Cost Explorer values are **AWS actuals, delayed** and can lag by roughly 24 hours.
- CloudWatch and application traffic rollups are near-real-time estimates.
- Mock/demo mode (`COST_DASHBOARD_MOCK_MODE=true`) lets local development render the full UI without AWS credentials.

### Actual vs estimated values

Use Cost Explorer service/usage-type totals as billing source of truth when available. Use CloudWatch and app traffic rollups to explain root causes and forecast month-end impact. Rows marked `actual` come from AWS billing data; `estimated` rows come from metrics and configurable pricing; `inferred` rows are rule-based warnings when a high-risk resource exists but billing data is incomplete.

### Reducing Cred-x data transfer costs

Start with the **Top bandwidth routes/assets** table:

- Images: resize large assets, compress, serve WebP/AVIF, and set long cache headers.
- Videos: avoid serving video directly from EC2; use YouTube, S3 + CloudFront, or a video CDN.
- API JSON: paginate, gzip/brotli compress, cache stable responses, and reduce polling frequency.
- JavaScript/CSS: split bundles, remove unused code, and cache hashed assets.
- Bots/crawlers: add `robots.txt`, rate limits, WAF/Cloudflare rules, and block abusive agents.
- Hidden AWS resources: review Transfer Family, NAT Gateway, ALB, unattached EBS, public IPv4, old snapshots, and never-expiring CloudWatch log groups.
