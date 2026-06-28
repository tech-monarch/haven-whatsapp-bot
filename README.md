# Haven WhatsApp Bot

A WhatsApp bot for the Haven service marketplace — connecting customers to trusted service providers in Nigeria. Built with [Baileys](https://github.com/WhiskeySockets/Baileys), [Groq](https://groq.com), and PostgreSQL.

---

## What's inside

```
src/
├── ai/
│   ├── agent.js          # AI conversation engine (context-aware, offline-resilient)
│   ├── aiClient.js       # AI facade — generateText / generateJSON
│   └── prompt.js         # System + user prompt builders (system/user split)
├── api/
│   ├── backendClient.js  # Haven backend HTTP client (classifies network vs HTTP errors)
│   └── roleResolver.js   # Resolves user role from session cache or backend
├── artisans/
│   ├── artisanService.js # Local provider search (fallback when backend offline)
│   ├── mockData.js       # Seed / mock provider data
│   └── ranking.js        # Provider ranking logic
├── commands/
│   └── registry.js       # Zero-AI command dispatch (/menu, /jobs, etc.)
├── config/
│   ├── index.js          # Centralised config (reads .env)
│   ├── logger.js         # Pino logger
│   └── validateEnv.js    # Fail-fast env validation on boot
├── database/
│   ├── postgres.js       # PG pool + schema bootstrap
│   └── queries.js        # Artisan/provider SQL queries
├── providers/
│   ├── groqProvider.js   # Groq SDK wrapper (compound-beta-mini + web_search)
│   └── providerManager.js# Key rotation, failover, cooldown
├── sync/
│   ├── localProfile.js   # Local user profile store (pre-sync)
│   └── syncQueue.js      # Persistent background sync queue (exponential backoff)
└── whatsapp/
    ├── client.js         # Baileys socket, pairing, reconnect
    ├── messageHandler.js # Message pipeline (dedup → rate-limit → onboard → AI)
    ├── phoneUtils.js     # Phone normalisation / validation
    ├── registration.js   # Onboarding state machine (offline-first)
    └── session.js        # Session store (PostgreSQL + in-memory fallback)
index.js                  # Entry point — HTTP server + WhatsApp + sync daemon
```

---

## Quick start

```bash
cp .env.example .env
# Fill in GROQ_API_KEY, DATABASE_URL, WA_PHONE_NUMBER, BACKEND_BASE_URL, INTERNAL_API_KEY
npm install
npm start
```

On first boot you will see a pairing code — enter it in WhatsApp → Settings → Linked Devices → Link with phone number.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ | — | Groq API key |
| `GROQ_API_KEY_1` … `_10` | — | — | Multiple keys for rotation |
| `GROQ_MODEL` | — | `compound-beta-mini` | Any Groq model ID |
| `DATABASE_URL` | — | — | PostgreSQL connection string. Without it sessions are in-memory only |
| `WA_PHONE_NUMBER` | ✅ | — | Bot's WhatsApp number (digits only, e.g. `2348012345678`) |
| `SESSION_PATH` | — | `./whatsapp-session` | Baileys session directory |
| `BACKEND_BASE_URL` | ✅ | `http://localhost:3001` | Haven backend base URL |
| `INTERNAL_API_KEY` | ✅ | — | Shared secret for backend ↔ bot calls |
| `PORT` | — | `3000` | HTTP server port |
| `LOG_LEVEL` | — | `info` | `debug` / `info` / `warn` / `error` |
| `RENDER_EXTERNAL_URL` | — | — | Set on Render to enable self-ping keep-alive |
| `ADMIN_NUMBERS` | — | — | Comma-separated admin WhatsApp numbers |

---

## AI model — `compound-beta-mini`

The default model is `compound-beta-mini`. Key properties:

- **Built-in web search** — the provider automatically enables Groq's `web_search` tool so the AI can look up current prices, availability, and general questions without any extra setup.
- **System / user role split** — the system prompt is sent in the dedicated `system` role, not prepended to the user message. This gives significantly better instruction-following.
- **Fast** — compound-beta-mini is optimised for low-latency chat use cases.

To switch model, set `GROQ_MODEL` in `.env` (e.g. `GROQ_MODEL=llama-3.3-70b-versatile`). Web search is only auto-enabled for `compound-beta-mini` and `compound-beta`.

---

## Key features

### Offline-first authentication
If the Haven backend is unreachable during login or registration:
- The user's details are saved locally in `local_user_profiles`.
- The failed request is queued in `sync_queue` with exponential backoff.
- The user continues chatting as if fully onboarded.
- Once the backend comes back online, the daemon automatically completes the registration or login in the background — no action required from the user.

### Background sync daemon
- Started automatically 2 seconds after boot (so processors are registered first).
- Polls every 15 seconds for due items.
- Retry schedule: 30 s → 1 min → 2 min → 5 min → 10 min (then 10 min for all subsequent attempts).
- Max 10 attempts per item (configurable per enqueue call).
- Persisted in PostgreSQL — survives bot restarts, server restarts, and WhatsApp reconnects.
- Pending count is visible at `GET /health` → `pendingSync`.

### Graceful degradation
When the backend is offline:
- Provider search falls back to the local artisan database.
- The AI is informed of the outage and continues helping with general questions, service information, and enquiries.
- Only features that strictly require live backend data (bookings, job management) are temporarily unavailable, and the AI explains this naturally.

### Smarter AI conversations
- Up to 20 messages of conversation history are threaded into every prompt.
- The AI resolves follow-up questions without requiring the user to repeat context ("the second one", "what about in Lekki?").
- Intent extraction detects `is_followup` and `topic_changed` flags to guide natural transitions.
- The system prompt is sent in the correct `system` role — no more system instructions mixed into the user turn.
- Warm, consistent personality ("Ava") across all user roles.

### Conversation memory
Stored in PostgreSQL (`bot_sessions`) with in-memory fallback:
- Message history (last 50 messages)
- User preferences (name, last service, last location, last budget)
- Registration / onboarding state
- Last shown providers (for follow-up "connect me to #2" messages)

---

## HTTP endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Bot status, AI key health, pending sync count |
| `POST` | `/send` | `X-Internal-Key` | Send a WhatsApp message from the backend |

### `/health` response
```json
{
  "status": "ok",
  "service": "haven-bot",
  "connected": true,
  "pendingSync": 0,
  "aiKeys": [{ "provider": "groq", "keyIndex": 1, "active": true, "healthy": true, "failCount": 0 }],
  "timestamp": "2026-06-25T20:00:00.000Z"
}
```

### `/send` request body
```json
{ "to": "2348012345678", "text": "Your booking has been confirmed!" }
```

---

## Database schema

Four tables are created automatically on boot (idempotent `CREATE TABLE IF NOT EXISTS`):

| Table | Purpose |
|---|---|
| `artisans` | Local provider search index |
| `bot_sessions` | Per-conversation message history + preferences |
| `local_user_profiles` | Temporary profiles before backend sync succeeds |
| `sync_queue` | Persistent retry queue for failed backend requests |

---

## Deployment (Render)

1. Create a **Web Service** pointing at this repo.
2. Set all required environment variables.
3. Set `RENDER_EXTERNAL_URL` to your Render URL — this enables the self-ping keep-alive.
4. Use a **PostgreSQL** add-on (or external DB) and set `DATABASE_URL`.
5. The bot will generate a pairing code on first boot — check the logs.
