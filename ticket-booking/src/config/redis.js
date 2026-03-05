// src/config/redis.js
const Redis = require('ioredis');

let client = null;

function getRedisClient() {
  if (client) return client;

  client = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    })
    : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });

  client.on('connect', () => console.log('[Redis] Connected'));
  client.on('error', (err) => console.error('[Redis] Error:', err.message));
  client.on('close', () => console.warn('[Redis] Connection closed'));

  return client;
}

async function disconnectRedis() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { getRedisClient, disconnectRedis };
