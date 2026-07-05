/* ============================================================
   controllers/health.controller.js
   Health check — used to verify the API + DB are running
   ============================================================ */

const mongoose = require('mongoose');

const getDbStatus = () =>
  ({ 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' })[mongoose.connection.readyState]
  || 'unknown';

// Human-readable server uptime
const getUptime = () => {
  const totalSeconds = Math.floor(process.uptime());
  const hrs  = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hrs}h ${mins}m ${secs}s`;
};

const getHealth = (req, res) => {
  const dbStatus = getDbStatus();

  // BUG FIX: 'status' field missing tha — Electron ka main.js
  // waitForBackend() mein line 505 pe check karta hai:
  //   const isReady = status === 'ok' || status === 'ready';
  // Bina is field ke isReady hamesha false rehta tha → 60s timeout.
  res.status(200).json({
    success:     true,
    status:      dbStatus === 'connected' ? 'ok' : 'starting',  // ← FIX
    message:     'Clinic Management API Running',
    database:    dbStatus,
    models:      mongoose.modelNames(),
    uptime:      getUptime(),
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
};

module.exports = { getHealth };