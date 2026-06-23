# WhatsApp Artisan Marketplace Bot 🛠️

An AI-powered WhatsApp chatbot that helps users find and connect with verified artisans
(electricians, plumbers, mechanics, cleaners, technicians, carpenters, painters, etc).

Built with:
- **Node.js** + **Baileys** (`@whiskeysockets/baileys`) for WhatsApp connectivity
- **Google Gemini API** for natural language understanding and response generation
- **PostgreSQL** for artisan data, with an automatic **mock data fallback** so the bot
  works fully even before the production backend is ready

---

## 1. How it works

```
WhatsApp message
      │
      ▼
messageHandler.js  ──►  ai/agent.js
                            │
                            ├─► ai/gemini.js   (extract structured intent: service, location, urgency, budget)
                            │
                            ├─► artisans/artisanService.js
                            │         ├─► database/queries.js (PostgreSQL)   [if DATABASE_URL set]
                            │         └─► artisans/mockData.js (in-memory)   [fallback]
                            │
                            ├─► artisans/ranking.js  (scores + sorts results)
                            │
                            └─► ai/gemini.js   (turn ranked results into a natural reply)
                                      │
                                      ▼
                              WhatsApp reply sent
```

Conversation memory is kept in-memory per phone number (`whatsapp/session.js`), so the
bot remembers the last service/location/budget mentioned and can handle natural
follow-ups like "make it Lekki instead."

---

## 2. Project structure

```
src/
├── whatsapp/
│   ├── client.js          # Baileys connection, QR login, auto-reconnect, message intake
│   ├── messageHandler.js  # Validates + routes incoming messages, sends replies
│   └── session.js         # In-memory conversation memory (swappable for DB later)
│
├── ai/
│   ├── gemini.js          # Gemini API wrapper (text + JSON generation, error handling)
│   ├── prompt.js          # System prompt + prompt builders for intent extraction & replies
│   └── agent.js           # Orchestrates: extract intent → search → rank → reply
│
├── artisans/
│   ├── artisanService.js  # Unified search interface, auto DB/mock fallback + geocoding
│   ├── ranking.js         # Weighted scoring algorithm (rating/distance/availability/etc)
│   └── mockData.js        # 24 mock artisans across 7 categories for fallback mode
│
├── database/
│   ├── postgres.js        # Connection pool, schema setup, connection testing
│   └── queries.js         # Parameterized SQL queries (by service/location/rating/etc)
│
├── config/
│   ├── index.js           # Centralized env config (loads .env)
│   └── logger.js           # Lightweight leveled logger
│
└── index.js                # Boots everything + health-check HTTP server
```

---

## 3. Setup

### Prerequisites
- Node.js 18+
- A WhatsApp account (a spare number is recommended for testing, since Baileys uses
  WhatsApp's "Linked Devices" feature)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- (Optional) a PostgreSQL database

### Install

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-1.5-flash
DATABASE_URL=                 # leave empty to use mock data
PORT=3000
ADMIN_NUMBERS=
LOG_LEVEL=info
```

### Run locally

```bash
npm start
```

On first run you'll see a QR code printed in the terminal:

```
[whatsapp] Scan this QR code with WhatsApp (Linked Devices):
█████████████████████████
██ ▄▄▄▄▄ █▀█ █▄█▄▄▄▄▄ ████
...
```

Open WhatsApp on your phone → **Settings → Linked Devices → Link a Device** → scan the
QR code. Once connected you'll see:

```
[whatsapp] Connected successfully ✅
[index] WhatsApp client is ready to receive messages.
```

Your session is saved to `auth_sessions/` so you won't need to re-scan on every restart.
If you ever get logged out, delete that folder and re-scan.

### Try it

Send the bot a WhatsApp message like:

> "I need an electrician in Ikeja urgently"

It should reply with ranked artisan recommendations, similar to:

```
Here are the best electricians near you:

1. John Electrical Services
⭐ 4.9 rating
📍 Ikeja
⚡ Available now
Estimated response: 10 mins

2. Bright Fix Solutions
⭐ 4.7 rating
📍 Allen
Available today

Would you like me to connect you?
```

---

## 4. Switching to PostgreSQL

The bot **automatically** uses PostgreSQL once `DATABASE_URL` is set — no code changes
needed.

1. Set `DATABASE_URL` in `.env`, e.g.:
   ```
   DATABASE_URL=postgres://user:password@localhost:5432/artisan_marketplace
   ```
2. On boot, `database/postgres.js` will automatically run `ensureSchema()` to create the
   `artisans` table if it doesn't exist yet:
   ```sql
   CREATE TABLE artisans (
     id SERIAL PRIMARY KEY,
     name VARCHAR(255) NOT NULL,
     phone VARCHAR(50) NOT NULL,
     category VARCHAR(100) NOT NULL,
     description TEXT,
     rating NUMERIC(2,1) DEFAULT 0,
     completed_jobs INTEGER DEFAULT 0,
     location VARCHAR(255) NOT NULL,
     latitude DOUBLE PRECISION,
     longitude DOUBLE PRECISION,
     available BOOLEAN DEFAULT true,
     average_response_time INTEGER,
     price_range VARCHAR(100),
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW()
   );
   ```
3. Seed it with real artisans (you can reuse the shape in `artisans/mockData.js`, or use
   `queries.insertArtisan(...)`).
4. If the connection ever fails at runtime, `artisanService.js` automatically logs a
   warning and falls back to mock data for that request instead of crashing.

Check current mode anytime via the health endpoint:

```bash
curl http://localhost:3000/health
# { "status": "ok", "databaseMode": "mock" }   <-- or "postgres"
```

---

## 5. Ranking algorithm

Each artisan candidate is scored 0–1 using weighted factors:

| Factor              | Weight |
|----------------------|--------|
| Rating               | 40%    |
| Distance             | 25%    |
| Availability         | 20%    |
| Completed jobs (experience) | 10% |
| Price match          | 5%     |

See `artisans/ranking.js` for the full implementation (Haversine distance, normalization,
budget-tolerance scoring, etc). Results are always returned sorted best-first.

---

## 6. Memory model

```js
// whatsapp/session.js (current: in-memory Map)
{
  "2348012345678": {
    messages: [{ role: "user", text: "...", at: "..." }, ...],
    userPreferences: { lastService: "electrician", lastLocation: "Ikeja", lastBudget: null }
  }
}
```

This is intentionally isolated behind a small interface (`getSession`, `appendMessage`,
`setPreferences`, etc.) so swapping in PostgreSQL/MongoDB later only requires rewriting
`whatsapp/session.js` — no other file needs to change.

---

## 7. Security & reliability notes

- All user input is length-checked and validated before being sent to Gemini.
- Gemini failures (timeouts, malformed JSON, rate limits) never crash the process — the
  agent falls back to deterministic, rule-based replies (`ai/agent.js` →
  `buildDeterministicFallback`).
- Database failures automatically fall back to mock data per-request.
- `process.on('uncaughtException'/'unhandledRejection')` guards are in place in
  `index.js`.
- Group messages are ignored by default (`config.whatsapp.ignoreGroups`).
- The AI is explicitly instructed (system prompt in `ai/prompt.js`) to never invent
  artisan data and to only use artisans actually returned by search.

---

## 8. What's next (hooks for the real backend)

- Replace `artisans/mockData.js`-based filtering with your production search/recommendation
  service once it's ready — `artisanService.js` already isolates this behind
  `searchArtisans()`.
- Replace `geocodeLocation()` in `artisanService.js` with a real geocoding API call.
- Add a "connect me" flow that notifies the chosen artisan and/or creates a job request
  in your backend (currently the bot only offers to connect, per the system prompt).
- Swap `whatsapp/session.js` for a persistent store (Postgres/Mongo/Redis) for multi-instance
  deployments.
