# 🎟️ Concurrent Ticket Booking System

A production-ready concurrent ticket booking API using **Node.js**, **Express**, and **Redis distributed locking** to safely prevent double-booking under high load.

---

## Architecture

```
Client Requests (concurrent)
        │
        ▼
  Express API (rate-limited)
        │
        ▼
  Booking Service
        │
        ├── 1. Pre-check seat status (fast path)
        ├── 2. Acquire Redis Lock  ← SET key token NX PX ttl
        ├── 3. Re-verify under lock (double-check pattern)
        ├── 4. Mark seat "locked" in seats hash
        ├── 5. Process booking (pipeline: atomic writes)
        └── 6. Release lock (Lua script — owner-only release)
```

### Why Redis Locking?

Without locking, two users booking the same seat at the same moment can both read "available", both proceed, and both get a confirmation — a classic race condition. Redis `SET NX PX` is **atomic**: only one caller gets `OK`, everyone else gets `nil`. The Lua script for release ensures only the lock owner can release it, preventing accidental unlocks.

---

## Project Structure

```
src/
├── app.js                    # Express entry point
├── config/
│   ├── redis.js              # Redis client (ioredis)
│   └── keys.js               # Centralised Redis key schema
├── modules/
│   └── booking/
│       ├── booking.service.js   # Business logic + locking
│       └── booking.controller.js # HTTP layer
├── routes/
│   └── index.js
└── utils/
    ├── lock.js               # acquireLock / releaseLock
    ├── response.js           # Standardised JSON responses
    └── seeder.js             # Redis test data seeder

tests/
└── booking.test.js           # Jest integration tests

load-test/
└── scenario.yml              # Artillery load test
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- Redis 6+ (running locally or via Docker)

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Redis credentials if needed
```

### 3. Start Redis (Docker shortcut)

```bash
docker run -d -p 6379:6379 --name redis redis:7-alpine
```

### 4. Seed Events

```bash
npm run seed
```

### 5. Start the Server

```bash
npm start        # production
npm run dev      # with auto-reload (nodemon)
```

---

## API Reference

All endpoints are prefixed with `/api`.

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server + Redis status |

### Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events` | List all events |
| GET | `/api/events/:eventId` | Event details + seat counts |
| GET | `/api/events/:eventId/seats` | All seats with status |
| POST | `/api/events/:eventId/book` | Book a seat |

**Book a seat — request body:**
```json
{
  "seatId": "S001",
  "userId": "user-123"
}
```

**Response codes:**
- `201` — Booking confirmed
- `409` — Seat already taken
- `423` — Seat is locked (another user is booking it, retry shortly)
- `404` — Seat or event not found

### Bookings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bookings/:bookingId` | Get booking details |
| DELETE | `/api/bookings/:bookingId` | Cancel a booking |

**Cancel — request body:**
```json
{ "userId": "user-123" }
```

---

## Running Tests

```bash
npm test
```

Tests cover:
- Normal booking flow
- Rejection of already-confirmed seats
- **Concurrent booking of the same seat** (race condition prevention)
- Cancellation + seat release
- Authorization checks

---

## Load Testing

```bash
# Ensure server is running first
npm start

# In another terminal
npm run load-test
```

The Artillery scenario simulates a ticket rush:
- Warm-up → Ramp-up to 50 req/s → Sustained peak → Cool-down
- Verifies p95 < 500ms, p99 < 1s, error rate < 5%

---

## Redis Key Schema

| Key | Type | Purpose |
|-----|------|---------|
| `event:{id}:meta` | Hash | Event name, totalSeats |
| `event:{id}:seats` | Hash | `{ seatId → available\|locked\|confirmed }` |
| `lock:{eventId}:{seatId}` | String | Distributed lock (TTL: 30s) |
| `booking:{bookingId}` | Hash | Full booking record |
| `event:{id}:bookings` | Set | All bookingIds for event |
| `event:{id}:booking_count` | String | Counter |

---

## Lock Design Details

```
┌─────────────────────────────────────────────────────────────┐
│                    acquireLock Flow                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  SET lock:EVT001:S001  <uuid-token>  NX  PX 30000          │
│                                                             │
│  Result = OK  →  Lock acquired, proceed                     │
│  Result = nil →  Retry with jitter (up to 3 attempts)       │
│               →  All retries fail → return 423 Locked       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                   releaseLock (Lua)                         │
├─────────────────────────────────────────────────────────────┤
│  if GET(key) == token → DEL(key)   (atomic, owner-only)     │
│  else → no-op          (prevents releasing someone else's)  │
└─────────────────────────────────────────────────────────────┘
```

The TTL (30s) is a safety net: if the server crashes mid-booking, the lock auto-expires and the seat becomes bookable again.
