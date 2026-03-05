// src/modules/booking/booking.service.js
const { v4: uuidv4 } = require('uuid');
const { getRedisClient } = require('../../config/redis');
const KEYS = require('../../config/keys');
const { acquireLock, releaseLock, LOCK_TTL_MS } = require('../../utils/lock');

const BOOKING_TTL_S = parseInt(process.env.BOOKING_TTL_S) || 0;

// ─── Get event info ───────────────────────────────────────────────────────────
async function getEvent(eventId) {
  const redis = getRedisClient();
  const meta = await redis.hgetall(`event:${eventId}:meta`);
  if (!meta || !meta.id) return null;

  const seats = await redis.hgetall(KEYS.eventSeats(eventId));
  const counts = { available: 0, locked: 0, confirmed: 0 };
  for (const status of Object.values(seats)) {
    if (counts[status] !== undefined) counts[status]++;
    else counts.locked++; // 'locked' prefix
  }

  return { ...meta, totalSeats: parseInt(meta.totalSeats), seats: counts };
}

// ─── List all seats ───────────────────────────────────────────────────────────
async function getSeats(eventId) {
  const redis = getRedisClient();
  const exists = await redis.exists(`event:${eventId}:meta`);
  if (!exists) return null;

  const raw = await redis.hgetall(KEYS.eventSeats(eventId));
  if (!raw) return [];

  // Enrich with lock TTL for locked seats
  const seatList = await Promise.all(
    Object.entries(raw).map(async ([seatId, status]) => {
      const entry = { seatId, status };
      if (status === 'locked') {
        const ttl = await redis.pttl(KEYS.seatLock(eventId, seatId));
        entry.lockExpiresInMs = ttl > 0 ? ttl : 0;
      }
      return entry;
    })
  );

  return seatList.sort((a, b) => a.seatId.localeCompare(b.seatId));
}

// ─── Book a seat (with distributed lock) ─────────────────────────────────────
async function bookSeat(eventId, seatId, userId) {
  const redis = getRedisClient();

  // 1. Verify event exists
  const eventMeta = await redis.hget(`event:${eventId}:meta`, 'name');
  if (!eventMeta) {
    return { success: false, code: 'EVENT_NOT_FOUND', message: `Event ${eventId} does not exist` };
  }

  // 2. Check seat exists
  const currentStatus = await redis.hget(KEYS.eventSeats(eventId), seatId);
  if (currentStatus === null) {
    return { success: false, code: 'SEAT_NOT_FOUND', message: `Seat ${seatId} not found` };
  }

  // 3. Quick pre-check (not authoritative — lock is the authority)
  if (currentStatus === 'confirmed') {
    return { success: false, code: 'SEAT_TAKEN', message: `Seat ${seatId} is already booked` };
  }

  // 4. Acquire distributed lock
  const lockKey = KEYS.seatLock(eventId, seatId);
  const lock = await acquireLock(lockKey, LOCK_TTL_MS);

  if (!lock.acquired) {
    return {
      success: false,
      code: 'SEAT_LOCKED',
      message: `Seat ${seatId} is currently being booked by another user. Please try again shortly.`,
    };
  }

  try {
    // 5. Re-read status inside the lock (double-check pattern)
    const statusUnderLock = await redis.hget(KEYS.eventSeats(eventId), seatId);
    if (statusUnderLock === 'confirmed') {
      return { success: false, code: 'SEAT_TAKEN', message: `Seat ${seatId} was just booked by someone else` };
    }

    // 6. Mark seat as locked in seats hash
    await redis.hset(KEYS.eventSeats(eventId), seatId, 'locked');

    // 7. Simulate payment/processing delay (remove in production)
    await sleep(50);

    // 8. Confirm booking — create booking record
    const bookingId = `BKG-${uuidv4().slice(0, 8).toUpperCase()}`;
    const bookingData = {
      bookingId,
      eventId,
      eventName: eventMeta,
      seatId,
      userId,
      status: 'confirmed',
      bookedAt: new Date().toISOString(),
    };

    const pipeline = redis.pipeline();
    // Persist booking record — one hset per field for Redis 3.x compatibility
    for (const [field, value] of Object.entries(bookingData)) {
      pipeline.hset(KEYS.booking(bookingId), field, value);
    }
    if (BOOKING_TTL_S > 0) pipeline.expire(KEYS.booking(bookingId), BOOKING_TTL_S);
    // Mark seat as confirmed
    pipeline.hset(KEYS.eventSeats(eventId), seatId, 'confirmed');
    // Track bookings for the event
    pipeline.sadd(KEYS.eventBookings(eventId), bookingId);
    pipeline.incr(KEYS.eventBookingCount(eventId));
    await pipeline.exec();

    return { success: true, booking: bookingData };
  } finally {
    // Always release the lock — even if booking fails
    await releaseLock(lockKey, lock.token);
  }
}

// ─── Cancel a booking ─────────────────────────────────────────────────────────
async function cancelBooking(bookingId, userId) {
  const redis = getRedisClient();

  const booking = await redis.hgetall(KEYS.booking(bookingId));
  if (!booking || !booking.bookingId) {
    return { success: false, code: 'NOT_FOUND', message: 'Booking not found' };
  }
  if (booking.userId !== userId) {
    return { success: false, code: 'FORBIDDEN', message: 'Not your booking' };
  }
  if (booking.status === 'cancelled') {
    return { success: false, code: 'ALREADY_CANCELLED', message: 'Booking already cancelled' };
  }

  const pipeline = redis.pipeline();
  // Single-field hset calls for Redis 3.x compatibility
  pipeline.hset(KEYS.booking(bookingId), 'status', 'cancelled');
  pipeline.hset(KEYS.booking(bookingId), 'cancelledAt', new Date().toISOString());
  pipeline.hset(KEYS.eventSeats(booking.eventId), booking.seatId, 'available');
  pipeline.decr(KEYS.eventBookingCount(booking.eventId));
  await pipeline.exec();

  return { success: true, message: `Booking ${bookingId} cancelled. Seat ${booking.seatId} is now available.` };
}

// ─── Get a booking ────────────────────────────────────────────────────────────
async function getBooking(bookingId) {
  const redis = getRedisClient();
  const booking = await redis.hgetall(KEYS.booking(bookingId));
  if (!booking || !booking.bookingId) return null;
  return booking;
}

// ─── Get all events ───────────────────────────────────────────────────────────
async function listEvents() {
  const redis = getRedisClient();
  const keys = await redis.keys('event:*:meta');
  const events = await Promise.all(
    keys.map(async (k) => {
      const eventId = k.split(':')[1];
      return getEvent(eventId);
    })
  );
  return events.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { bookSeat, cancelBooking, getBooking, getEvent, getSeats, listEvents };
