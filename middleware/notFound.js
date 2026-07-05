/* ============================================================
   middleware/notFound.js
   Catches requests to undefined routes and returns a 404
   ============================================================ */

const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

module.exports = notFound;
