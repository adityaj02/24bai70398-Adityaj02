// src/config/keys.js
// Centralised Redis key schema — change prefixes here, not scattered across code.

const KEYS = {
  // Hash storing all seat statuses for an event: { seatId -> 'available' | 'confirmed' }
  eventSeats: (eventId) => `event:${eventId}:seats`,

  // String key used as a distributed lock for a specific seat
  seatLock: (eventId, seatId) => `lock:${eventId}:${seatId}`,

  // Hash storing booking details keyed by bookingId
  booking: (bookingId) => `booking:${bookingId}`,

  // Set of all booking IDs for an event (useful for admin/analytics)
  eventBookings: (eventId) => `event:${eventId}:bookings`,

  // String counter: total bookings made for an event
  eventBookingCount: (eventId) => `event:${eventId}:booking_count`,
};

module.exports = KEYS;
