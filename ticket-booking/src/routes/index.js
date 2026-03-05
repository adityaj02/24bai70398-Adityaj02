// src/routes/index.js
const express = require('express');
const ctrl = require('../modules/booking/booking.controller');

const router = express.Router();

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  const { getRedisClient } = require('../config/redis');
  let redisStatus = 'disconnected';
  try {
    const pong = await getRedisClient().ping();
    redisStatus = pong === 'PONG' ? 'connected' : 'unknown';
  } catch (_) {}
  res.json({ status: 'ok', redis: redisStatus, timestamp: new Date().toISOString() });
});

// ── Events ────────────────────────────────────────────────────────────────────
router.get('/events', ctrl.listEvents);
router.get('/events/:eventId', ctrl.getEvent);
router.get('/events/:eventId/seats', ctrl.getSeats);
router.post('/events/:eventId/book', ctrl.bookSeat);

// ── Bookings ──────────────────────────────────────────────────────────────────
router.get('/bookings/:bookingId', ctrl.getBooking);
router.delete('/bookings/:bookingId', ctrl.cancelBooking);

module.exports = router;
