# Disenyo Inquiry Assistant

An AI chat that answers questions about Disenyo Digitals and records qualified leads in HQ. It is part of the disenyodigitals.com site and deploys with it.

## How it works

A visitor clicks **Inquire with AI** on disenyodigitals.com (`inquire-widget.js`), or opens the chat from the Heyzine profile. The chat page at `/inquire/` sends each message to `POST /api/inquiry`, a Vercel function in the same project, which:

1. checks the origin, the input and the rate limits;
2. loads the session's earlier messages;
3. asks OpenAI (`gpt-6-luna`) for a reply plus the extracted lead fields, in one structured response;
4. decides the stage and score itself, using the "ready for consultation" rule;
5. saves the lead to `inquiry_leads` in HQ Supabase;
6. sends one alert (email and/or Telegram) when the lead becomes ready or asks for a person, and one follow-up if contact details arrive after that alert.

The browser never sees a key. The planning docs (PRD, security review, budget) are kept privately, outside this public repo.

## Where things are

```
inquire-widget.js            (site root) the "Inquire with AI" button and panel
inquire/                     (site root) the built chat page, served at /inquire/. Generated: don't edit
api/inquiry.ts               (site root) Vercel function entry point
inquiry-app/
  index.html, src/           chat page source (plain TypeScript + CSS)
  server/handler.ts          request flow: validate, limits, agent, save, alert
  server/agent.ts            OpenAI call (model, structured output, 25 s deadline)
  server/readiness.ts        ready rule, stage and score decisions, "delete my data"
  server/validate.ts         input and origin checks
  server/notifier.ts         email (Resend) and Telegram alerts (console in dev)
  server/stores/             memoryStore (dev/tests), supabaseStore (prod)
  knowledge/disenyo.md       what the AI knows
  prompts/system.md          behaviour rules
  database/                  021_inquiry_leads.sql + checks, for Gab to run in HQ
  tests/                     Vitest tests + conversation-scripts.md (run by hand)
```

`/inquiry-app/...` is redirected away in `vercel.json`, so the source isn't served as files.

## Run locally

```bash
cd inquiry-app
npm install
cp .env.example .env.local   # fill in OPENAI_API_KEY at minimum
npm run dev                  # http://localhost:5173/inquire/ , serves the page and /api/inquiry
npm test                     # unit tests (no keys needed)
```

Without Supabase settings, leads are kept in memory and lost on restart. Without Telegram settings, alerts print in the terminal.

## Change the chat page

Edit `inquiry-app/src/` or `inquiry-app/index.html`, then rebuild and commit the result in `inquire/`:

```bash
cd inquiry-app
npm run build    # type check + build into ../inquire
```

The site has no build step on Vercel, so the built `inquire/` folder is what goes live.

## Edit what the AI knows

1. Change `knowledge/disenyo.md`. Fill in every `[TEAM TO FILL]` before launch. Until then, the assistant treats those items as unknown and offers a consultation.
2. Run the scripts in `tests/conversation-scripts.md`.
3. Commit and push. No rebuild needed: the function reads the file on each cold start.

To change behaviour (tone, question order, handoff rules), edit `prompts/system.md`.

## Environment variables (Vercel project for disenyodigitals.com)

The names start with `INQUIRY_` so they can't be confused with the PayMongo registration settings (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), which point at a different database. `RESEND_API_KEY` keeps its standard name because the Vercel Resend integration sets it.

Alerts go to every channel that is set up: email, Telegram, or both. With neither, they only appear in the Vercel function logs.

| Name | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI key (platform.openai.com), ideally in its own `disenyo-inquiry` project so its costs are separate |
| `INQUIRY_OPENAI_MODEL` | Optional. Default `gpt-6-luna` |
| `INQUIRY_SUPABASE_URL` | HQ Supabase project URL |
| `INQUIRY_SUPABASE_ANON_KEY` | HQ's public anon key. After migration 021 it can call the three inquiry functions. |
| `RESEND_API_KEY` | Email alerts. Set automatically by linking the team's Resend account (Vercel → Integrations → Resend). |
| `INQUIRY_ALERT_EMAIL_TO` | Who gets alert emails, comma-separated, e.g. `info@destinevents.biz` |
| `INQUIRY_ALERT_EMAIL_FROM` | Optional. Default `Disenyo AI Inquiries <alerts@disenyodigitals.com>` (disenyodigitals.com is verified in Resend) |
| `INQUIRY_TELEGRAM_BOT_TOKEN` | Optional Telegram alerts: from @BotFather |
| `INQUIRY_TELEGRAM_CHAT_ID` | Optional: the team group's chat id |
| `INQUIRY_ALLOWED_ORIGINS` | `https://disenyodigitals.com,https://www.disenyodigitals.com`. Empty means localhost only. |
| `INQUIRY_IP_HASH_SALT` | Any long random string. IPs are stored only as salted hashes. |

## Deploy

1. Gab runs `database/migrations/021_inquiry_leads.sql`, then `database/tests/021_checks.sql`, in the HQ Supabase SQL Editor.
2. Link the team's Resend account to the Vercel project (this sets `RESEND_API_KEY`) and set `INQUIRY_ALERT_EMAIL_TO`. Telegram is optional.
3. Create the OpenAI key, add credit and set a monthly budget.
4. Add the environment variables above to the disenyodigitals.com Vercel project.
5. Push to `main`. Vercel deploys the site, `/inquire/` and `/api/inquiry` together.
6. Run the conversation scripts against `https://disenyodigitals.com/inquire/`.
7. Optional: add the Heyzine link (`https://disenyodigitals.com/inquire/?source=heyzine`) and the iframe interaction.

`vercel.json` sets the function to 256 MB and 60 s (OpenAI gets at most 25 s of that, so a slow answer still ends in a saved message), bundles `prompts/` and `knowledge/`, and lets only this site and Heyzine frame the chat page.

## Demos, booking and leads

- **Demos and booking are handled in code** (`server/actions.ts`), not by the AI, so the links are always right: "demo", "sample work", "portfolio" and the "Watch demo" button show the All Services demo; "Browse demos (Clinic / Staycation)" shows the clinic and staycation demos; every one of these ends with the booking link.
- **"Talk to a person" and "Book a call"** answer straight away with the Calendly link (https://calendly.com/disenyodigitalsdemo). The chat never asks for a name or contact details: Calendly collects them and emails the team for every booking. Nothing is "sent to the team" from the chat, and the chat never says so.
- The clinic demo video is hosted on the site itself (`demos/clinic-demo.mp4`); the other two are on Google Drive and must stay shared as "Anyone with the link can view".
- To add a demo, add it to `DEMOS` in `server/actions.ts` and to `quickAnswer`, then run `npm test` and `npm run build`.
- Every conversation is still saved in `inquiry_leads` in the HQ Supabase project. Only HQ admins can read them.
- Alert emails (and Telegram, if set up) go out only when a prospect volunteers a phone or email in the chat and is ready or asks for a person, plus any "delete my data" request. Bookings come by email from Calendly instead.
- Alert emails come from `alerts@disenyodigitals.com`. When the prospect gave an email, it is the Reply-To, so the team can answer with Reply.
- To export leads, open the table view in Supabase and download a CSV.

## Costs and limits

- Model: `gpt-6-luna` (US$0.10 / $0.50 per million input / output tokens, about ₱0.30 per conversation), with reasoning off and at most 800 output tokens. OpenAI caches the repeated rules and knowledge base automatically. Responses are sent with `store: false`, so OpenAI doesn't keep the chats.
- Limits: 20 messages per session, 30 per IP per hour, 2,000 characters per message.
- Set a monthly budget in the OpenAI dashboard.

## Privacy

- The consent line ("Disenyo Digitals will use your name and contact details only to respond to this inquiry...") is shown once, when contact details are first asked for or given. `consent_at` is recorded when contact details are given after the line was shown.
- Retention: 12 months (a placeholder for Jenn to confirm).
- Deletion: when a prospect types "delete my data", the chat confirms and the team gets a Telegram alert. An admin then deletes the row in Supabase.
