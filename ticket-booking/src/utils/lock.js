// src/utils/lock.js
/**
 * Distributed Seat Lock using Redis SET NX PX (atomic acquire).
 *
 * Design:
 *  - acquireLock: SET key token NX PX ttl   → only one caller wins
 *  - releaseLock: Lua script ensures only the lock owner can release
 *  - retry: exponential back-off up to LOCK_RETRY_ATTEMPTS
 */

const { getRedisClient } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');

const LOCK_TTL_MS = parseInt(process.env.SEAT_LOCK_TTL_MS) || 30000;
const RETRY_ATTEMPTS = parseInt(process.env.LOCK_RETRY_ATTEMPTS) || 3;
const RETRY_DELAY_MS = parseInt(process.env.LOCK_RETRY_DELAY_MS) || 200;

// Lua script: release lock only if token matches (prevents accidental foreign-lock release)
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

async function acquireLock(lockKey, ttlMs = LOCK_TTL_MS) {
  const redis = getRedisClient();
  const token = uuidv4(); // unique owner token

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    // SET key token NX PX ttl — atomic: set only if key does NOT exist
    const result = await redis.set(lockKey, token, 'NX', 'PX', ttlMs);

    if (result === 'OK') {
      return { acquired: true, token, lockKey };
    }

    if (attempt < RETRY_ATTEMPTS) {
      // Jittered back-off: base delay + random jitter (avoids thundering herd)
      const jitter = Math.random() * RETRY_DELAY_MS;
      await sleep(RETRY_DELAY_MS * attempt + jitter);
    }
  }

  return { acquired: false, token: null, lockKey };
}

async function releaseLock(lockKey, token) {
  if (!token) return false;
  const redis = getRedisClient();
  const released = await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
  return released === 1;
}

async function getLockTTL(lockKey) {
  const redis = getRedisClient();
  return redis.pttl(lockKey); // milliseconds remaining, -2 if key gone
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { acquireLock, releaseLock, getLockTTL, LOCK_TTL_MS };
