// src/modules/booking/booking.controller.js
const service = require('./booking.service');
const { success, error } = require('../../utils/response');

// GET /events
async function listEvents(req, res) {
  try {
    const events = await service.listEvents();
    return success(res, { events, count: events.length });
  } catch (err) {
    console.error('[listEvents]', err);
    return error(res, 'Failed to fetch events', 500);
  }
}

// GET /events/:eventId
async function getEvent(req, res) {
  try {
    const event = await service.getEvent(req.params.eventId);
    if (!event) return error(res, 'Event not found', 404);
    return success(res, { event });
  } catch (err) {
    console.error('[getEvent]', err);
    return error(res, 'Failed to fetch event', 500);
  }
}

// GET /events/:eventId/seats
async function getSeats(req, res) {
  try {
    const seats = await service.getSeats(req.params.eventId);
    if (!seats) return error(res, 'Event not found', 404);
    return success(res, { seats, count: seats.length });
  } catch (err) {
    console.error('[getSeats]', err);
    return error(res, 'Failed to fetch seats', 500);
  }
}

// POST /events/:eventId/book
async function bookSeat(req, res) {
  const { seatId, userId } = req.body;
  const { eventId } = req.params;

  if (!seatId || !userId) {
    return error(res, 'seatId and userId are required');
  }

  try {
    const result = await service.bookSeat(eventId, seatId, userId);

    if (!result.success) {
      const statusMap = {
        EVENT_NOT_FOUND: 404,
        SEAT_NOT_FOUND: 404,
        SEAT_TAKEN: 409,
        SEAT_LOCKED: 423, // HTTP 423 Locked
      };
      return error(res, result.message, statusMap[result.code] || 400);
    }

    return success(res, { booking: result.booking }, 201);
  } catch (err) {
    console.error('[bookSeat]', err);
    return error(res, 'Booking failed due to server error', 500);
  }
}

// DELETE /bookings/:bookingId
async function cancelBooking(req, res) {
  const { bookingId } = req.params;
  const { userId } = req.body;

  if (!userId) return error(res, 'userId is required');

  try {
    const result = await service.cancelBooking(bookingId, userId);

    if (!result.success) {
      const statusMap = { NOT_FOUND: 404, FORBIDDEN: 403, ALREADY_CANCELLED: 409 };
      return error(res, result.message, statusMap[result.code] || 400);
    }

    return success(res, { message: result.message });
  } catch (err) {
    console.error('[cancelBooking]', err);
    return error(res, 'Cancellation failed', 500);
  }
}

// GET /bookings/:bookingId
async function getBooking(req, res) {
  try {
    const booking = await service.getBooking(req.params.bookingId);
    if (!booking) return error(res, 'Booking not found', 404);
    return success(res, { booking });
  } catch (err) {
    console.error('[getBooking]', err);
    return error(res, 'Failed to fetch booking', 500);
  }
}

module.exports = { listEvents, getEvent, getSeats, bookSeat, cancelBooking, getBooking };
