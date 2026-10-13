# API Error Explainer

Paste a failed Claude API request, some log lines, or a customer's ticket. Code pulls out the hard facts first (status, error type, request ID, retry-after, rate-limit headers, spend-cap code), then Claude explains what went wrong, says whose side the fix is on, links the right docs, and drafts two replies: one for the customer's technical admin and one for an executive.

- **Live demo:** https://api-error-explainer.caseyledbetter.com (live calls need an access code)
- **Works with:** [Doc Gap Finder](https://doc-gap-finder.caseyledbetter.com), which hands API error tickets to this tool with one click. It also works on its own with its own sample queue.
- **Stack:** static HTML/CSS/JS, two Vercel functions in Node (no framework, no dependencies), Claude API with structured outputs, Supabase for access codes and the spend cap.

## How it works

1. **Parse with code.** `lib/catalog.js` reads the status, error type, request ID, `retry-after`, `anthropic-ratelimit-*` headers and `error_code` from the pasted text, so the page can show "what the request says" separately from Claude's reading of it. It also tells a spend-cap 429 (`enforced_spend_limit_reached`, no `retry-after`) apart from a normal rate limit.
2. **Remove secrets.** Anything that looks like an API key or auth header is replaced with `[REDACTED]` before it's sent anywhere.
3. **Explain with Claude.** One call with a JSON schema returns the headline, whose side the fix is on, evidence, ordered fix steps, retry guidance, docs, open questions, the two replies, and whether to escalate. The doc links are an enum of 16 pages checked by hand, so Claude can't invent a URL.
4. **Gate every call.** See below.

## Access codes and the $15 cap

Live calls cost money, so every request needs an access code, and the budget is enforced in Postgres before Claude is called:

| Rule | Limit |
|---|---|
| Total across this tool and [SSO Assistant](https://github.com/CSLedbetter/sso-assistant) | $15 |
| Per access code | $5 |
| Requests per code per hour | 30 |
| Input size | 8,000 characters |

Each request reserves its worst-case cost first (input size plus the full output budget), then settles to the real cost from the API's token counts. Parallel requests can't overshoot the cap, a call that never reached Claude settles to $0, and a timeout that might have been billed keeps its reservation. Codes are stored only as SHA-256 hashes, and the tables have RLS on with no policies, so the public anon key can't read or spend anything.

**Manage codes** in the Supabase SQL editor:

```sql
select public.demo_create_code('Jane Doe, Anthropic recruiter');   -- returns the code once; share it
select public.demo_revoke_code('Jane Doe, Anthropic recruiter');   -- turn a code off
select * from public.demo_usage_by_code;                            -- who used what, and what it cost
update public.demo_settings set enabled = false;                    -- kill switch for both tools
```

The schema is in `supabase/migrations/20261013200000_demo_access.sql`.

## Run it locally

```
cp .env.example .env.local   # add your own keys
npm test                     # unit tests and handler tests with fake Supabase and Claude
npx vercel dev               # serves public/ and api/ at http://localhost:3000
```

## Environment variables

Server-side only, set in Vercel. See `.env.example`.

- `ANTHROPIC_API_KEY`: a dedicated key for this demo, ideally in its own Console workspace with a spend limit as a backstop.
- `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: the project that holds the codes and the cap.
- `CLAUDE_MODEL` (optional): defaults to `claude-sonnet-5-5`, about $0.01 to $0.03 per explanation.

A daily Vercel cron calls `/api/ping` so the free Supabase project doesn't pause before a live demo.

## Sample data

The tickets in `public/tickets.json` are fictional. The error bodies follow the shapes in the [Claude API errors docs](https://platform.claude.com/docs/en/api/errors).
