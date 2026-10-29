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

`wgpk-ideas-email-ingest` (`infra/ideas-email-worker/`) is a copy of `wgpk-concierge/infra/opera-analytics-email-worker`
that differs only in also accepting .xlsx; IDeaS G3 exports Excel only. The OPERA address and its wyndham.com-only
rule are untouched.

## Report to schedule in IDeaS

Monitor → Reports → Data Extraction: All Data at Property level, all competitors selected, start today, end +365 days,
Excel (the only format), daily early morning, e-mail to ideas-reports@wyndhamgardenkamala.com. Scheduling needs the
G3 "schedule reports" permission (on 2026-10-29 Gary's user did not have it). Until then an export can be posted by
hand: `curl -X POST --data-binary @export.xlsx -H "Authorization: Bearer $OTA_INGEST_TOKEN" https://ota.wyndhamgardenkamala.com/api/ingest/ideas`.

## Sender lock

The Worker accepts only `ALLOWED_SENDER_DOMAIN`, the envelope sender's domain. It is deployed with the
placeholder `sender-not-pinned.invalid`, which rejects every sender. On IDeaS's first send:

1. Run `npx wrangler@4 tail wgpk-ideas-email-ingest --format json` before IDeaS sends (live only). The email
   event shows the envelope `from`. The Cloudflare dashboard (Email → Email Routing → Activity log) shows it too.
2. Set `ALLOWED_SENDER_DOMAIN` to that domain in `wrangler.ideas.jsonc` and deploy again.
3. Ask IDeaS to send again ("send now", or wait for the next scheduled run).

Never set it to anything that accepts any sender.

## One-time setup (Cloudflare account owner)

From `infra/ideas-email-worker/`:

```sh
npm ci && npm run deploy
npx wrangler@4 email routing rules create wyndhamgardenkamala.com --name "IDeaS report archive" \
  --match-type literal --match-field to --match-value ideas-reports@wyndhamgardenkamala.com \
  --action-type worker --action-value wgpk-ideas-email-ingest --priority 30
```

Check: `npx wrangler@4 email routing rules list wyndhamgardenkamala.com` shows the rule enabled.

Accepted attachments: csv/tsv/txt/dat/xml/pdf/xlsx, at most 24 MB per email. The cockpit imports .xlsx sent to
this address (cockpit/src/ideas.js); any other layout is blocked with a reason in `ideas_bridge_receipts`.
