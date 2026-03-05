// src/utils/response.js

function success(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    timestamp: new Date().toISOString(),
    ...data,
  });
}

function error(res, message, statusCode = 400, details = null) {
  const body = {
    success: false,
    timestamp: new Date().toISOString(),
    error: message,
  };
  if (details) body.details = details;
  return res.status(statusCode).json(body);
}

module.exports = { success, error };
