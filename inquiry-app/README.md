# Disenyo Inquiry Assistant

An AI chat that answers questions about Disenyo Digitals and records qualified leads in HQ. It is part of the disenyodigitals.com site and deploys with it.

## How it works

A visitor clicks **Inquire with AI** on disenyodigitals.com (`inquire-widget.js`), or opens the chat from the Heyzine profile. The chat page at `/inquire/` sends each message to `POST /api/inquiry`, a Vercel function in the same project, which:

1. checks the origin, the input and the rate limits;
2. loads the session's earlier messages;
3. asks Claude Haiku 5.5 for a reply plus the extracted lead fields, in one structured response;
4. decides the stage and score itself, using the "ready for consultation" rule;
5. saves the lead to `inquiry_leads` in HQ Supabase;
6. sends one Telegram alert when the lead becomes ready or asks for a person, and one follow-up if contact details arrive after that alert.

The browser never sees a key. The planning docs (PRD, security review, budget) are kept privately, outside this public repo.

## Where things are

```
inquire-widget.js            (site root) the "Inquire with AI" button and panel
inquire/                     (site root) the built chat page, served at /inquire/. Generated: don't edit
api/inquiry.ts               (site root) Vercel function entry point
inquiry-app/
  index.html, src/           chat page source (plain TypeScript + CSS)
  server/handler.ts          request flow: validate, limits, agent, save, alert
  server/agent.ts            Claude call (model, prompt caching, structured output, 25 s deadline)
  server/readiness.ts        ready rule, stage and score decisions, "delete my data"
  server/validate.ts         input and origin checks
  server/notifier.ts         Telegram alert (console in dev)
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
cp .env.example .env.local   # fill in ANTHROPIC_API_KEY at minimum
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

The names start with `INQUIRY_` because the project already has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the AYA registrations, which use a different database.

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | A dedicated `disenyo-inquiry` key, not HQ's |
| `INQUIRY_SUPABASE_URL` | HQ Supabase project URL |
| `INQUIRY_SUPABASE_ANON_KEY` | HQ's public anon key. After migration 021 it can call the three inquiry functions. |
| `INQUIRY_TELEGRAM_BOT_TOKEN` | From @BotFather |
| `INQUIRY_TELEGRAM_CHAT_ID` | The team group's chat id |
| `INQUIRY_ALLOWED_ORIGINS` | `https://disenyodigitals.com,https://www.disenyodigitals.com`. Empty means localhost only. |
| `INQUIRY_IP_HASH_SALT` | Any long random string. IPs are stored only as salted hashes. |

## Deploy

1. Gab runs `database/migrations/021_inquiry_leads.sql`, then `database/tests/021_checks.sql`, in the HQ Supabase SQL Editor.
2. Create the Telegram bot and get the chat id.
3. Create the Anthropic key, add credit and set a monthly spend limit.
4. Add the environment variables above to the disenyodigitals.com Vercel project.
5. Push to `main`. Vercel deploys the site, `/inquire/` and `/api/inquiry` together.
6. Run the conversation scripts against `https://disenyodigitals.com/inquire/`.
7. Optional: add the Heyzine link (`https://disenyodigitals.com/inquire/?source=heyzine`) and the iframe interaction.

`vercel.json` sets the function to 256 MB and 60 s (Claude gets at most 25 s of that, so a slow answer still ends in a saved message), bundles `prompts/` and `knowledge/`, and lets only this site and Heyzine frame the chat page.

## Leads and alerts

- Leads are stored in `inquiry_leads` in the HQ Supabase project. Only HQ admins can read them.
- Alerts go to the Telegram group: once per lead when it becomes ready or asks for a person, plus any "delete my data" request. If that first alert had no phone or email, a second alert brings the contact details as soon as the prospect gives them.
- To export leads, open the table view in Supabase and download a CSV.

## Costs and limits

- Model: `claude-haiku-5-5`, with thinking off and at most 800 output tokens. The rules and knowledge base are prompt-cached.
- Limits: 20 messages per session, 30 per IP per hour, 2,000 characters per message.
- Set a monthly spend limit in the Anthropic console.

## Privacy

- The consent line ("Disenyo Digitals will use your name and contact details only to respond to this inquiry...") is shown once, when contact details are first asked for or given. `consent_at` is recorded when contact details are given after the line was shown.
- Retention: 12 months (a placeholder for Jenn to confirm).
- Deletion: when a prospect types "delete my data", the chat confirms and the team gets a Telegram alert. An admin then deletes the row in Supabase.
