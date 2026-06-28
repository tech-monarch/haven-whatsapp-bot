# Root Cause Analysis & Fix Log

## Issue 1 — Authentication always returns "Unauthorized"

### Root cause
The bot called two endpoints that **do not exist** on the backend:
- `POST /api/v1/internal/login`
- `POST /api/v1/internal/register-user`

These internal routes are not defined in `src/modules/internal/internal.routes.ts`. The backend returned 404, which the bot treated as an auth failure and reported as "Unauthorized".

Additionally:
- The bot sent `{ name }` but the backend `registerCustomerSchema` requires `{ fullName }` → Zod validation would have rejected it with a 400 even if the endpoint existed.
- The bot tried "login by phone + password" — the backend `POST /api/v1/auth/login` requires **email + password**, not phone.

### The two API surfaces (traced from backend source)

| Surface | Prefix | Auth header | Used for |
|---|---|---|---|
| Internal (bot-only) | `/api/v1/internal` | `X-Internal-Key` | Resolve user by phone, CRUD for customer/provider data |
| Public auth | `/api/v1/auth` | none | Register new user, login, refresh token |

### Correct flow (now implemented)
1. Phone number collected → `POST /api/v1/internal/resolve-user { phone }`  
   - **200**: existing user found → session set to `authenticated`; no password needed  
   - **404**: new user → collect `fullName`, `email`, `password`  
     → `POST /api/v1/auth/register/customer { fullName, email, phone, password }`  
     → store `{ accessToken, refreshToken }` from response

### Files changed
- `src/api/backendClient.js` — removed non-existent endpoints; added `registerCustomer()` (correct public route + correct field name `fullName`) and `loginWithEmail()` (correct email+password auth)
- `src/whatsapp/registration.js` — rewrote state machine to use correct flow

---

## Issue 2 — `sync_queue` table missing at runtime

### Root cause
Race condition in the startup sequence. The previous code used `setTimeout(2000)` to delay daemon start, assuming the DB schema would be ready by then. If the DB connection was slow (Render cold start, Railway provisioning), `ensureSchema()` hadn't run yet when the daemon's first tick tried to INSERT into `sync_queue`.

### Fix
Sequential async startup in `index.js`:
```
1. validateEnv()
2. db.testConnection()
3. db.ensureSchema()       ← ALL tables created synchronously before anything else
4. require('registration') ← sync processors registered
5. syncQueue.startDaemon() ← safe: sync_queue guaranteed to exist
6. connectToWhatsApp()     ← safe: bot_sessions guaranteed to exist
```
No `setTimeout`, no races.

### Files changed
- `src/index.js` — `start()` async function with sequential await chain
- `src/database/postgres.js` — `ensureSchema()` documented as requiring sequential call

---

## Issue 3 — `local_user_profiles.conversation_history` NOT NULL violation

### Root cause
The `upsert()` in `localProfile.js` passed JavaScript `null` as the parameter for `conversation_history` when `fields.conversationHistory` was `undefined`.

In PostgreSQL, an explicit `NULL` in an `INSERT` statement **overrides the column DEFAULT**. So even though the column has `DEFAULT '[]'`, passing `NULL` directly violates the `NOT NULL` constraint.

```js
// Bug (previous code):
fields.conversationHistory
  ? JSON.stringify(fields.conversationHistory)
  : null   // ← explicit NULL overrides DEFAULT '[]'

// Fix:
fields.conversationHistory
  ? JSON.stringify(fields.conversationHistory)
  : '[]'   // ← valid JSON array string, satisfies NOT NULL
```

Same fix applied to `preferences` (`{}` instead of `null`).

### Files changed
- `src/sync/localProfile.js` — never pass `null` for NOT NULL JSONB columns

---

## Issue 4 — Groq `tools[0].type must be one of [function,mcp]`

### Root cause
The bot passed `tools: [{ type: 'web_search' }]` to the Groq API. Groq's API only accepts `type: "function"` or `type: "mcp"` in the `tools` array.

`compound-beta-mini`'s web search capability is **built-in and automatic** — it runs when the model determines a web lookup would help. You do **not** declare it as a tool. There is no tool type called `web_search` in the Groq API.

### Fix
Remove the `tools` array entirely from `groqProvider.js`. `compound-beta-mini` will use web search automatically when needed.

### Files changed
- `src/providers/groqProvider.js` — removed `tools` array

---

## Issue 5 — Registration trapped users in a loop

### Root cause
`handleRegistration` returned `{ handled: true }` for any message it didn't recognise in a registration state, swallowing the message without passing it to the AI. Users who asked a question mid-registration got no answer, just silence or a repeat of the registration prompt.

### Fix
`looksLikeRegistrationInput(state, text)` detects whether a message is actually answering the current registration prompt:
- **Phone input**: only if it looks like digits (7+ chars, may include +/spaces)
- **YES/NO confirmation**: only if the answer is `yes`, `y`, `no`, `n`
- **Name**: only if 2+ chars and not a command
- **Email**: only if it contains `@`
- **Password**: always treated as registration input (last step, user is ready)

Any other message in any registration state passes through to the AI with a `regContext` object describing the current state. The AI prompt instructs Ava to answer the question **first**, then gently continue registration at the end.

### Files changed
- `src/whatsapp/registration.js` — `looksLikeRegistrationInput()`, `regContext` returned always
- `src/whatsapp/messageHandler.js` — passes `regContext` to `handleUserMessage()`
- `src/ai/agent.js` — accepts `regContext`, passes to `buildResponsePrompt()`
- `src/ai/prompt.js` — `buildRegBlock()` injects registration guidance into system prompt

---

## Issue 6 — Backend config: missing `internalApiKey` and `botBaseUrl`

### Root cause
`src/config/index.ts` does not export `whatsapp.internalApiKey` or `whatsapp.botBaseUrl`. The actual config is in `src/config.ts` (a different file). The `internalAuth` middleware imports from `../config` which resolves to `src/config/index.ts` — missing those keys.

### Impact
`internalAuth` middleware: `config.whatsapp.internalApiKey` is always `undefined` → in development mode it allows all requests; in production it blocks all internal routes with 503.

### Fix (for the backend — not in this bot delivery but documented here)
In `src/config/index.ts`, add to the `whatsapp` block:
```ts
whatsapp: {
  botNumber:      optional('HAVEN_BOT_WHATSAPP', '2349017335663'),
  supportNumber:  optional('HAVEN_SUPPORT_WHATSAPP', '2349017335663'),
  botBaseUrl:     optional('BOT_BASE_URL', 'http://localhost:3000'),
  internalApiKey: optional('INTERNAL_API_KEY', ''),
},
bcryptRounds: parseInt(optional('BCRYPT_ROUNDS', '10'), 10),
```
And set `INTERNAL_API_KEY` in the backend `.env` to a real secret (not `<your_secret>`).

---

## Additional bugs found

### A. Backend `.env` has `INTERNAL_API_KEY=<your_secret>`
The placeholder was never replaced. Both bot and backend need the same real secret value.

### B. Backend has two config files
`src/config.ts` and `src/config/index.ts` both exist and export `config`. The middleware and routes import from `src/config` which resolves to `src/config/index.ts`, missing `internalApiKey`, `botBaseUrl`, and `bcryptRounds`. These are only in `src/config.ts`. This is a dead-code / confusion risk.

### C. `resolveUser` returns full backend data without password being involved
This is correct and intentional — for the bot, "authentication" means phone number verification, not password verification. The bot does not need to store or use passwords for existing users. Only new registrations require a password (to create the backend account). This design is correct; it was just not implemented that way before.

### D. Access token not used by current agent
The `accessToken` returned from registration is stored in session preferences but not currently used — all agent calls go through the internal API (`X-Internal-Key`). This is correct. The token is stored for future use if you add user-facing authenticated routes.

---

## Files changed summary

| File | Change |
|---|---|
| `src/api/backendClient.js` | Fixed endpoints, correct field names, added `registerCustomer` / `loginWithEmail` / `refreshAccessToken` |
| `src/api/roleResolver.js` | Handles provisional users, new session fields, network fallback |
| `src/ai/agent.js` | Accepts `regContext`, passes to prompt builder, handles unauthenticated action attempts |
| `src/ai/aiClient.js` | Passes `system` param through |
| `src/ai/prompt.js` | `buildRegBlock()` — registration-aware system prompt injection |
| `src/database/postgres.js` | Documented startup order, added sequential schema guarantee |
| `src/providers/groqProvider.js` | Removed invalid `web_search` tool type |
| `src/providers/providerManager.js` | Forwards `system` param |
| `src/sync/localProfile.js` | Fixed NOT NULL violation (`null` → `'[]'` / `'{}'`) |
| `src/sync/syncQueue.js` | No change needed (was already correct) |
| `src/whatsapp/messageHandler.js` | Passes `regContext` to AI agent |
| `src/whatsapp/registration.js` | Correct backend endpoints, non-blocking state machine, `looksLikeRegistrationInput` |
| `src/index.js` | Sequential startup — schema before daemon, no `setTimeout` race |
