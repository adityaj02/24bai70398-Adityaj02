// src/app.js
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const routes = require('./routes');
const { getRedisClient } = require('./config/redis');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security & Logging ────────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// ── Rate Limiting (protect booking endpoint from flood) ───────────────────────
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,            // max 100 requests per IP per minute
  message: { success: false, error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', bookingLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  // Warm up Redis connection
  await getRedisClient().ping();
  console.log('[Redis] Ready');

  app.listen(PORT, () => {
    console.log(`\n🎟️  Ticket Booking Server running on http://localhost:${PORT}`);
    console.log(`   API docs: http://localhost:${PORT}/api/health\n`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app; // for testing
