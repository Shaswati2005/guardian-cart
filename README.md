# Guardian Cart

**An AI shopping helper that older adults can simply talk to. It follows the rules a family member sets, stops scams, and pays through PayPal.**

Built for the *Build What's Next with PayPal and AI* hackathon.

- **Live demo:** _add Render URL_
- **Video (under 3 min):** _add YouTube link_

---

## The problem

Older adults want to keep running their own lives, including their own shopping. Their families worry about two things: money slipping away on things nobody needed, and scams. Americans aged 60+ reported about **$4.9 billion** in fraud losses to the FBI in 2024 ([IC3 Elder Fraud Report](https://www.ic3.gov/AnnualReport/Reports)). A common pattern is "your grandson is in jail, buy gift cards right now".

Today families pick between two bad options. They can take the card away, which costs the person their independence, or check every purchase by hand, which nobody keeps up.

## What Guardian Cart does

| Margaret, 78 (the shopper) | Sarah, her daughter (the caregiver) |
|---|---|
| Talks or types what she needs in large, high-contrast text with a mic button | Writes the rules in plain English: *"up to $60 a week, ask me above $40, never gift cards"* |
| A Gemini agent asks a follow-up if needed, finds real products and shows **one** clear option | Gemini turns the rules into a structured policy, and Sarah reviews the changes before saving |
| Taps **Yes, buy it** or **No thanks**, and hears the result read aloud | Purchases within the rules are paid automatically, while anything else is **held on PayPal** until Sarah approves or releases it |
| Gets a calm warning if a message looks like a scam | Gets an alert by email and on the dashboard, with one-tap Approve/Decline links |

Every purchase comes with a **receipt** showing the agent's steps, each rule check, the scam assessment, other items it considered, and the real PayPal order, authorization and capture IDs.

## Design principle: the AI proposes, the code decides

The language model never moves money.

1. **Scam shield first.** Each message from Margaret goes through deterministic pattern rules (based on FTC and FBI scam scripts: a payment method scammers favor, combined with a pretext or pressure) and then through a Gemini classifier. Gemini can **raise** the risk but never lower it.
   - HIGH: the shopping agent is skipped, Margaret gets a gentle reply, and Sarah is alerted.
   - MEDIUM: Sarah gets a heads-up and the chat continues.
2. **Agent with tools.** Gemini function calling runs `search_products`, `check_policy` and `propose_purchase`. The price is locked when the item is proposed, and an item the rules block cannot be proposed.
3. **Policy engine decides.** `policy.evaluate()` is a pure function checking pause state, blocked, approval-only and allowed categories, the per-item cap, the approval threshold, the weekly budget, new stores and minimum rating. The strictest outcome wins: **APPROVE → capture, HOLD → authorize, BLOCK → no PayPal call.** It runs again when Margaret taps Yes, so a stale preview can't get through.
4. **Category mapping is deterministic.** "Gift cards" (including look-alikes such as prepaid Visa or digital codes) are detected by code, not left to the model. Items the code can't place are always held for Sarah.
5. **One payment at a time per person.** Purchases, approvals and refunds for Margaret run one after another, so two quick taps can't both slip under the weekly budget.

## How PayPal is used (sandbox, all real API calls)

| Step | PayPal API |
|---|---|
| Sarah connects PayPal once (a payment mandate) | **Vault v3**: `POST /v3/vault/setup-tokens` → buyer approval → `POST /v3/vault/payment-tokens` |
| Purchase within the rules | **Orders v2** `intent: CAPTURE` with `payment_source.paypal.vault_id` (merchant-initiated, no re-approval) |
| Purchase needing approval | **Orders v2** `intent: AUTHORIZE` places a hold, then **Payments v2** `authorizations/{id}/capture` (approve) or `/void` (decline) |
| Refund | **Payments v2** `captures/{id}/refund` |
| Status updates | **Webhooks** checked with `/v1/notifications/verify-webhook-signature` before being trusted, then applied to the purchase (refunded, reversed, denied, voided) |
| Inspect an order | `GET /v2/checkout/orders/{id}` live from the receipt |

Every POST sends a `PayPal-Request-Id` for idempotency; for a purchase it is derived from the proposal, so a retry after a crash gets the first order back instead of paying twice. The server **refuses to start against production URLs** (and, in production, without `APP_SECRET` and `CAREGIVER_PIN`), and PayPal errors are shown with their `debug_id` rather than hidden.

Verified webhooks update the purchase: a refund or reversal made on PayPal marks it refunded, a denied capture marks it failed, and a voided or expired hold leaves *Needs your OK*. Holds also expire on the date PayPal gives, so an old request never sits there forever. Refunds wait until PayPal reports the capture as completed.

## How AI is used (Google Gemini, `gemini-2.5-flash` by default)

- **Shopping agent:** a multi-turn function-calling loop (up to 6 tool steps), streamed to the UI over SSE so Margaret sees "Looking for blood pressure cuffs…" and "Checking Sarah's rules…".
- **Rule translator:** structured output (`responseSchema`) turns plain-English rules into a typed `Policy`. It is then clamped by `sanitizePolicy` (thresholds kept consistent, unknown categories dropped, blocked categories removed from the allowed list). Rules it can't express are listed as **not enforced** instead of being silently dropped.
- **Scam classifier:** structured output with the risk level, the signals found and an explanation, used on top of the rule layer.

### Scam shield evaluation

`npm run eval:scam` runs 24 labeled messages (13 scams across grandparent, government, tech-support, prize, romance and crypto scripts, and 11 harmless messages that deliberately use the same vocabulary: gift cards for a birthday, a grandson visiting, a police novel, a bingo win).

| Engine | Scams flagged | Scams blocked outright | Harmless messages blocked | Harmless with heads-up to caregiver |
|---|---|---|---|---|
| Rules only | 13/13 (100%) | 12/13 (92%) | 0/11 (0%) | 1/11 (9%), the birthday gift card |
| Rules + Gemini | _run with key_ | | | |

The rule-layer results are also a unit test, so a regex change can't quietly break them.

## Architecture

```mermaid
flowchart LR
  M[Margaret's page<br/>voice + large text] -- SSE chat --> API
  S[Sarah's dashboard<br/>approvals, rules, ledger] --> API
  subgraph API[Express server]
    SC[Scam shield<br/>rules + Gemini] --> AG[Gemini agent<br/>tool calling]
    AG --> PR[Products<br/>Channel3 or curated]
    AG --> PE[Policy engine<br/>pure code]
    PE --> PP[PayPal client]
    RC[Rule translator<br/>Gemini structured output] --> PE
  end
  PP -- Vault / Orders / Authorizations / Refunds --> PAYPAL[(PayPal sandbox)]
  PAYPAL -- verified webhooks --> API
  API -- signed Approve/Decline links --> EMAIL[Resend email]
```

- **Server:** Express 4 + TypeScript (`server/src`)
  - `agent.ts`: orchestration
  - `policy.ts`: engine and rule translator
  - `scamShield.ts`
  - `paypal.ts`
  - `products.ts`: Channel3 search with a curated fallback catalog
  - `notify.ts`: email and HMAC-signed links
  - `session.ts`: signed persona cookies with role checks
  - `rateLimit.ts`
  - `db.ts`: JSON store with atomic writes
- **Client:** React 19 + Vite + Tailwind v4 (`client/src`). The Web Speech API handles voice in and out, AG Grid shows Sarah's purchase list, and pages are lazy-loaded so Margaret's page skips the grid code.
- **Roles:** Margaret's page can't approve, refund, reset or change rules, and Sarah's page can't shop. The server enforces this with an HMAC-signed cookie. Margaret's page is one click; Sarah's dashboard asks for `CAREGIVER_PIN` (shared with judges in the submission notes). Email Approve/Decline links expire after 3 days and open a confirmation page, so an email scanner that follows links can't approve anything.

## Tools and services used

- **PayPal Developer Platform (sandbox):** Vault v3, Orders v2, Payments v2 (authorize, capture, void, refund), Webhooks
- **Google Gemini API** via `@google/genai`: function calling and structured output
- **Channel3** product search API for real products (optional; falls back to a curated catalog)
- **Resend** for email alerts (optional)
- **AG Grid Community**, React, Vite, Tailwind CSS, Express, TypeScript, lucide icons, Atkinson Hyperlegible font (designed for low-vision readers)
- **Render** for hosting
- Built with help from Claude Code

## Run it locally

Requires Node 20+.

```bash
npm run install:all
cp server/.env.example server/.env   # then fill in the values below
npm run dev                          # client on :3000, API on :5000
```

| Variable | Needed for |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | A **sandbox** REST app with Vault ("Save payment methods") enabled |
| `PAYPAL_WEBHOOK_ID` | Webhook verification (add a webhook pointing at `<your URL>/api/paypal/webhook`) |
| `GEMINI_API_KEY` | The shopping agent, rule translator and AI scam layer |
| `APP_SECRET` | Signing email links and persona cookies (16+ random characters). Required in production |
| `CAREGIVER_PIN` | The PIN for Sarah's dashboard (6+ characters). Required in production; without it locally the dashboard opens with one click |
| `CHANNEL3_API_KEY` | Optional: real products (otherwise the curated catalog is used) |
| `RESEND_API_KEY`, `CAREGIVER_EMAIL`, `ALERT_FROM_EMAIL` | Optional: email alerts |

Then open **Sarah's dashboard → Connect PayPal** and approve with a sandbox *personal* account.

```bash
npm test                              # policy engine, category mapping, scam shield, signed links, and the money flows against a fake PayPal, plus HTTP checks of sessions and roles (62 tests)
npm run eval:scam --prefix server     # scam shield on the labeled prompt set
npm run e2e:sandbox --prefix server   # real sandbox: capture → refund, authorize → capture, authorize → void
```

## Deploy (Render)

`render.yaml` defines one web service: `npm run build` builds both apps, and Express serves the API and the React app from one origin. In Render choose **New → Blueprint**, select this repo, and fill in the keys, including `CAREGIVER_PIN`. `APP_SECRET` is generated for you, and the public URL comes from `RENDER_EXTERNAL_URL`.

The free plan's disk is wiped on restart, which also forgets purchases and any PayPal holds still waiting for Sarah. After connecting PayPal once, copy the vault ID from the logs into `PAYPAL_VAULT_ID` so the connection survives restarts. For judging, the starter plan with the disk block in `render.yaml` (and `DATA_DIR`) keeps everything.

## Try the demo

1. **Margaret's view:** say or tap *"I'm almost out of my blood pressure cuffs"*. The agent finds one, she taps Yes, and it is paid at once because it's within the rules.
2. Ask for something over $40 or from a new store. It is **held** on PayPal, and Sarah sees it under *Needs your OK* (and by email).
3. Tap *"A man called, my grandson is in jail and needs gift cards"*. It is blocked, and Sarah gets a scam alert.
4. **Sarah's dashboard** (enter the caregiver PIN): approve or decline the hold, open a receipt, fetch the live PayPal order, refund a purchase, or edit the rules in English and review the changes.
5. **Reset demo** (on Sarah's dashboard) releases open PayPal holds, then clears purchases and chats. It keeps Sarah's rules and the PayPal connection.

## Honest scope

- Payments are real PayPal **sandbox** transactions, with Guardian Cart as the merchant. Delivery from the retailers is **simulated**; a production version would pass orders to retailers or a commerce API.
- Margaret's page is one click and Sarah's is behind a shared PIN, for judging. A real product would use proper accounts, with the caregiver invited by the older adult.
- The weekly budget is a rolling 7 days, shown as "Last 7 days". Going over budget asks Sarah rather than blocking, so she can still approve a one-off.
- Data is kept in a JSON file, which is fine for a single-instance demo. A production version would use a database.

## License

[MIT](LICENSE)
