# InfluenceOS

Independent standalone version of **InfluenceOS** separated from the DoxTox / EMS monorepo.

InfluenceOS is a partner, influencer, campaign, contribution, payment, withdrawal, team, file proof, and helpdesk management platform.

## Project structure

```txt
InfluenceOS-standalone/
├── index.html
├── assets/
│   ├── app.css
│   └── app.js
├── functions/
│   └── api/
│       └── ios/
│           └── [[path]].js
├── supabase/
│   └── migrations/
│       ├── 001_influenceros_schema.sql
│       ├── 002_contribute_changelog.sql
│       ├── 003_files_vaultium_helpdesk.sql
│       ├── 004_payment_methods.sql
│       ├── 005_withdrawals.sql
│       ├── 006_team_members.sql
│       ├── 007_allocation_categories.sql
│       ├── 008_team_allocations.sql
│       └── 009_agent_register_address.sql
├── package.json
├── wrangler.toml
├── .env.example
├── .gitignore
├── _headers
└── README.md
```

## What was separated

This standalone project includes only:

- InfluenceOS frontend (`index.html`, `assets/app.css`, `assets/app.js`)
- InfluenceOS Cloudflare Pages API (`functions/api/ios/[[path]].js`)
- InfluenceOS Supabase migrations (`supabase/migrations/*`)
- Cloudflare / Wrangler configuration for an independent deployment

EMS, DoxTox landing page files, EMS modules, EMS layouts, EMS migrations, and EMS API routes were intentionally removed.

## Required services

- Cloudflare Pages
- Cloudflare R2 bucket for uploaded proof/files
- Supabase project dedicated to InfluenceOS

## Environment variables

Set these in Cloudflare Pages → Settings → Environment variables:

```bash
IOS_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
IOS_SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
IOS_SESSION_SECRET=replace-with-a-long-random-secret-at-least-32-characters
```

For local development, copy `.env.example` to `.dev.vars` and fill in the values.

## R2 bucket

`wrangler.toml` uses a dedicated binding:

```toml
[[r2_buckets]]
binding = "VAULTIUM"
bucket_name = "emsvaultium"
```

Create the bucket in Cloudflare R2 or change `bucket_name` to your existing bucket name.

## Supabase setup

Run the SQL files in `supabase/migrations/` in order inside a fresh Supabase project.

Recommended order:

1. `001_influenceros_schema.sql`
2. `002_contribute_changelog.sql`
3. `003_files_vaultium_helpdesk.sql`
4. `004_payment_methods.sql`
5. `005_withdrawals.sql`
6. `006_team_members.sql`
7. `007_allocation_categories.sql`
8. `008_team_allocations.sql`
9. `009_agent_register_address.sql`

## Local development

```bash
npm install
cp .env.example .dev.vars
# edit .dev.vars with real values
npm run dev
```

Open the local Wrangler URL.

## Deployment

```bash
npm install
npm run deploy
```

Or connect this folder/repository to Cloudflare Pages and deploy using:

- Build command: empty or `npm install`
- Build output directory: `.`
- Functions directory: `functions`

## API path

The frontend calls the API at:

```txt
/api/ios/*
```

The matching Cloudflare Pages Function is located at:

```txt
functions/api/ios/[[path]].js
```

This keeps the existing working API namespace while making the entire app independent from EMS.
