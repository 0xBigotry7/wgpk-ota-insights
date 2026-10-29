# IDeaS G3 scheduled reports → agent

Goal: for a limited apprenticeship (6–8 weeks) the ota agent reads IDeaS's daily decisions next to its own,
learns what IDeaS uses, and records where they differ, so the hotel can later run without IDeaS.

## Path

```
IDeaS G3 scheduled report (CSV, daily, early morning)
  → ideas-reports@wyndhamgardenkamala.com
  → Email Routing rule → Worker wgpk-ideas-email-ingest
  → D1 wgpk-opera-analytics (report_emails.recipient = ideas-reports@…) + R2 wgpk-opera-analytics (reports/…)
  → cockpit pms-bridge (IDeaS parser, written from the first archived file) → /api/agent/*
```

`wgpk-ideas-email-ingest` is a second instance of `wgpk-concierge/infra/opera-analytics-email-worker`
with the code unchanged; only `infra/ideas-email-worker/wrangler.ideas.jsonc` differs (name, address,
sender). The OPERA address and its wyndham.com-only rule are untouched.

## Reports to schedule in IDeaS (CSV, not Excel)

1. Daily decisions / BAR by stay date (with overrides)
2. Forecast vs on-the-books by stay date (occupancy / room nights, OTB, remaining demand)
3. Pickup / pace by stay date (since yesterday, last 7 days)

## Sender lock

The Worker accepts only `ALLOWED_SENDER_DOMAIN`, the envelope sender's domain. It is deployed with the
placeholder `sender-not-pinned.invalid`, which rejects every sender. On IDeaS's first send:

1. Run `npx wrangler@4 tail wgpk-ideas-email-ingest --format json` before IDeaS sends (live only). The email
   event shows the envelope `from`. The Cloudflare dashboard (Email → Email Routing → Activity log) shows it too.
2. Set `ALLOWED_SENDER_DOMAIN` to that domain in `wrangler.ideas.jsonc` and deploy again.
3. Ask IDeaS to send again ("send now", or wait for the next scheduled run).

Never set it to anything that accepts any sender.

## One-time setup (Cloudflare account owner)

From `infra/ideas-email-worker/`, with `wgpk-concierge` checked out next to this repo and its worker's
`npm ci` done:

```sh
npx wrangler@4 deploy -c wrangler.ideas.jsonc
npx wrangler@4 email routing rules create wyndhamgardenkamala.com --name "IDeaS report archive" \
  --match-type literal --match-field to --match-value ideas-reports@wyndhamgardenkamala.com \
  --action-type worker --action-value wgpk-ideas-email-ingest --priority 30
```

Check: `npx wrangler@4 email routing rules list wyndhamgardenkamala.com` shows the rule enabled.

Limits are inherited from the OPERA worker: csv/tsv/txt/dat/xml/pdf attachments (no xlsx), at most 24 MB per
email. The cockpit only parses IDeaS files after a parser exists for their columns.
