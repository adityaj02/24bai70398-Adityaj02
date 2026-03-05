// tests/booking.test.js
/**
 * Integration tests for the Ticket Booking System.
 * Requires a running Redis instance (set REDIS_HOST/REDIS_PORT in environment).
 *
 * Run with: npm test
 */

process.env.SEAT_LOCK_TTL_MS = '5000';
process.env.LOCK_RETRY_ATTEMPTS = '2';
process.env.LOCK_RETRY_DELAY_MS = '50';

const { bookSeat, cancelBooking, getBooking, getEvent, getSeats, listEvents } = require('../src/modules/booking/booking.service');
const { getRedisClient, disconnectRedis } = require('../src/config/redis');
const KEYS = require('../src/config/keys');

const TEST_EVENT = 'TEST_EVT';
const TOTAL_SEATS = 5;

// ─── Test Setup ───────────────────────────────────────────────────────────────
beforeAll(async () => {
  const redis = getRedisClient();
  await redis.ping(); // ensure connection

  // Seed a test event
  await redis.del(
    KEYS.eventSeats(TEST_EVENT),
    `event:${TEST_EVENT}:meta`,
    KEYS.eventBookingCount(TEST_EVENT),
    KEYS.eventBookings(TEST_EVENT)
  );
  // Redis 3.x only supports single-field HSET — use a pipeline for each field
  const seedPipeline = redis.pipeline();
  for (let i = 1; i <= TOTAL_SEATS; i++) {
    seedPipeline.hset(KEYS.eventSeats(TEST_EVENT), `S${String(i).padStart(3, '0')}`, 'available');
  }
  seedPipeline.hset(`event:${TEST_EVENT}:meta`, 'id', TEST_EVENT);
  seedPipeline.hset(`event:${TEST_EVENT}:meta`, 'name', 'Test Concert');
  seedPipeline.hset(`event:${TEST_EVENT}:meta`, 'totalSeats', TOTAL_SEATS);
  seedPipeline.hset(`event:${TEST_EVENT}:meta`, 'createdAt', new Date().toISOString());
  await seedPipeline.exec();
});

afterAll(async () => {
  const redis = getRedisClient();
  await redis.del(
    KEYS.eventSeats(TEST_EVENT),
    `event:${TEST_EVENT}:meta`,
    KEYS.eventBookingCount(TEST_EVENT),
    KEYS.eventBookings(TEST_EVENT)
  );
  await disconnectRedis();
});

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('Event & Seat Queries', () => {
  test('getEvent returns event with correct seat counts', async () => {
    const event = await getEvent(TEST_EVENT);
    expect(event).not.toBeNull();
    expect(event.id).toBe(TEST_EVENT);
    expect(event.seats.available).toBe(TOTAL_SEATS);
  });

  test('getEvent returns null for unknown event', async () => {
    const event = await getEvent('UNKNOWN');
    expect(event).toBeNull();
  });

  test('getSeats returns all seats as available', async () => {
    const seats = await getSeats(TEST_EVENT);
    expect(seats).toHaveLength(TOTAL_SEATS);
    expect(seats.every((s) => s.status === 'available')).toBe(true);
  });
});

describe('Booking a Seat', () => {
  test('successfully books an available seat', async () => {
    const result = await bookSeat(TEST_EVENT, 'S001', 'user-alice');
    expect(result.success).toBe(true);
    expect(result.booking.bookingId).toMatch(/^BKG-/);
    expect(result.booking.seatId).toBe('S001');
    expect(result.booking.status).toBe('confirmed');
  });

  test('rejects booking an already confirmed seat', async () => {
    const result = await bookSeat(TEST_EVENT, 'S001', 'user-bob');
    expect(result.success).toBe(false);
    expect(result.code).toBe('SEAT_TAKEN');
  });

  test('rejects booking a non-existent seat', async () => {
    const result = await bookSeat(TEST_EVENT, 'S999', 'user-charlie');
    expect(result.success).toBe(false);
    expect(result.code).toBe('SEAT_NOT_FOUND');
  });

  test('rejects booking for unknown event', async () => {
    const result = await bookSeat('GHOST_EVT', 'S001', 'user-dave');
    expect(result.success).toBe(false);
    expect(result.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('Concurrent Booking — Race Condition Prevention', () => {
  test('only one user wins when multiple users book the same seat concurrently', async () => {
    const seatId = 'S002';
    const users = ['u1', 'u2', 'u3', 'u4', 'u5'];

    // Fire all bookings simultaneously
    const results = await Promise.all(
      users.map((userId) => bookSeat(TEST_EVENT, seatId, userId))
    );

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(1);   // Exactly one winner
    expect(failures).toHaveLength(4);    // All others rejected
    expect(['SEAT_TAKEN', 'SEAT_LOCKED']).toContain(failures[0].code);
  });
});

describe('Cancellation', () => {
  let bookingId;

  beforeAll(async () => {
    const result = await bookSeat(TEST_EVENT, 'S003', 'user-cancel-test');
    bookingId = result.booking?.bookingId;
  });

  test('owner can cancel their booking', async () => {
    const result = await cancelBooking(bookingId, 'user-cancel-test');
    expect(result.success).toBe(true);
  });

  test('seat becomes available after cancellation', async () => {
    const redis = getRedisClient();
    const status = await redis.hget(KEYS.eventSeats(TEST_EVENT), 'S003');
    expect(status).toBe('available');
  });

  test('cannot cancel another user\'s booking', async () => {
    const r = await bookSeat(TEST_EVENT, 'S004', 'owner-user');
    const result = await cancelBooking(r.booking.bookingId, 'intruder-user');
    expect(result.success).toBe(false);
    expect(result.code).toBe('FORBIDDEN');
  });

  test('cannot cancel an already cancelled booking', async () => {
    const result = await cancelBooking(bookingId, 'user-cancel-test');
    expect(result.success).toBe(false);
    expect(result.code).toBe('ALREADY_CANCELLED');
  });
});

describe('Booking Retrieval', () => {
  test('getBooking returns booking details', async () => {
    const booked = await bookSeat(TEST_EVENT, 'S005', 'user-lookup');
    const booking = await getBooking(booked.booking.bookingId);
    expect(booking).not.toBeNull();
    expect(booking.seatId).toBe('S005');
  });

  test('getBooking returns null for unknown bookingId', async () => {
    const result = await getBooking('BKG-DOESNOTEXIST');
    expect(result).toBeNull();
  });
});

// ─── Cancellation edge: unknown bookingId ─────────────────────────────────────
describe('Cancellation — NOT_FOUND', () => {
  test('returns NOT_FOUND for a completely unknown bookingId', async () => {
    const result = await cancelBooking('BKG-FAKEID000', 'any-user');
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });
});

// ─── Booking counter ──────────────────────────────────────────────────────────
describe('Booking Counter', () => {
  const COUNTER_SEAT = 'S002'; // already confirmed by the concurrent-booking test

  test('booking count is a positive integer after previous bookings', async () => {
    const redis = getRedisClient();
    const raw = await redis.get(KEYS.eventBookingCount(TEST_EVENT));
    const count = parseInt(raw) || 0;
    // S001, S002 (concurrent winner), S003 (cancelled→re-available), S004, S005 all touched above
    expect(count).toBeGreaterThan(0);
  });

  test('booking count decrements after a cancellation', async () => {
    const redis = getRedisClient();

    // Book a fresh seat (S003 was cancelled earlier so it is available again)
    const bookResult = await bookSeat(TEST_EVENT, 'S003', 'counter-decrement-user');
    expect(bookResult.success).toBe(true);

    const after = parseInt(await redis.get(KEYS.eventBookingCount(TEST_EVENT)));

    // Cancel it
    await cancelBooking(bookResult.booking.bookingId, 'counter-decrement-user');

    const afterCancel = parseInt(await redis.get(KEYS.eventBookingCount(TEST_EVENT)));
    expect(afterCancel).toBe(after - 1);
  });
});

// ─── getSeats: locked-seat TTL enrichment ─────────────────────────────────────
describe('getSeats — lockExpiresInMs enrichment', () => {
  test('locked seat includes a positive lockExpiresInMs field', async () => {
    const redis = getRedisClient();
    const lockKey = KEYS.seatLock(TEST_EVENT, 'S004');

    // Manually plant a lock so we can inspect the enrichment
    await redis.set(lockKey, 'synthetic-token', 'NX', 'PX', 5000);
    // Force the seat status to 'locked' in the hash
    await redis.hset(KEYS.eventSeats(TEST_EVENT), 'S004', 'locked');

    const seats = await getSeats(TEST_EVENT);
    const s004 = seats.find((s) => s.seatId === 'S004');

    expect(s004).toBeDefined();
    expect(s004.status).toBe('locked');
    expect(typeof s004.lockExpiresInMs).toBe('number');
    expect(s004.lockExpiresInMs).toBeGreaterThan(0);

    // Clean up synthetic lock
    await redis.del(lockKey);
    await redis.hset(KEYS.eventSeats(TEST_EVENT), 'S004', 'confirmed'); // restore
  });
});

// ─── listEvents ───────────────────────────────────────────────────────────────
describe('listEvents', () => {
  test('returns an array that contains the test event', async () => {
    const events = await listEvents();
    expect(Array.isArray(events)).toBe(true);
    const found = events.find((e) => e.id === TEST_EVENT);
    expect(found).toBeDefined();
    expect(found.name).toBe('Test Concert');
    expect(found.totalSeats).toBe(TOTAL_SEATS);
  });

  test('every returned event has id, name, totalSeats and seats breakdown', async () => {
    const events = await listEvents();
    for (const ev of events) {
      expect(ev).toHaveProperty('id');
      expect(ev).toHaveProperty('name');
      expect(ev).toHaveProperty('totalSeats');
      expect(ev).toHaveProperty('seats');
      expect(ev.seats).toHaveProperty('available');
      expect(ev.seats).toHaveProperty('locked');
      expect(ev.seats).toHaveProperty('confirmed');
    }
  });

  test('events are sorted alphabetically by id', async () => {
    const events = await listEvents();
    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });
});

