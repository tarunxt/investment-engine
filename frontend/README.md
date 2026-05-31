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
