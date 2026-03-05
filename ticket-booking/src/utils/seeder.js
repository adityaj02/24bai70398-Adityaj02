// src/utils/seeder.js
require('dotenv').config();
const { getRedisClient, disconnectRedis } = require('../config/redis');
const KEYS = require('../config/keys');

const EVENTS = [
  { id: 'EVT001', name: 'IPL Final 2025 - Mumbai vs Chennai', totalSeats: 50 },
  { id: 'EVT002', name: 'Coldplay World Tour - Mumbai', totalSeats: 100 },
  { id: 'EVT003', name: 'Tech Conference 2025', totalSeats: 30 },
];

async function seed() {
  const redis = getRedisClient();
  console.log('\n🌱 Seeding events into Redis...\n');

  for (const event of EVENTS) {
    const seatsKey = KEYS.eventSeats(event.id);
    const metaKey = `event:${event.id}:meta`;

    // Wipe previous state
    await redis.del(seatsKey, metaKey, KEYS.eventBookingCount(event.id), KEYS.eventBookings(event.id));

    // Populate seat statuses: seatId -> 'available'
    const seatEntries = {};
    for (let i = 1; i <= event.totalSeats; i++) {
      const seatId = `S${String(i).padStart(3, '0')}`;
      seatEntries[seatId] = 'available';
    }
    await redis.hset(seatsKey, seatEntries);

    // Store event metadata
    await redis.hset(metaKey, {
      id: event.id,
      name: event.name,
      totalSeats: event.totalSeats,
      createdAt: new Date().toISOString(),
    });

    console.log(`  ✅ ${event.id} — "${event.name}" — ${event.totalSeats} seats`);
  }

  console.log('\n✅ Seed complete.\n');
  await disconnectRedis();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
