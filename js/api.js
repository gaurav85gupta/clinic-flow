/* ============================================================
   API.JS — Centralized API Layer
   MediCore Clinic Management System
   
   PURPOSE: Unified HTTP helpers for future backend integration.
   STATUS:  Structure only — no endpoints connected yet.
            Replace API_BASE with real server URL when ready.
   ============================================================ */

const API_BASE = 'http://localhost:5000/api';

/**
 * Phase 9.0 — reads the JWT issued at login and attaches it as a
 * Bearer token. Every backend route (dashboard included) runs
 * authenticate() first, so requests without this header always
 * get a 401 — this was a gap that pre-dates Phase 9.0, surfaced
 * now because the Dashboard module is the first page to actually
 * call the API. Storage key matches what the (separate) login
 * flow is expected to set on successful sign-in.
 */
function getAuthToken() {
  return localStorage.getItem('medicore_token');
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Reads the JSON error body from a failed response, if any, and
 * returns the server's actual message. Falls back to the status
 * code if the body isn't JSON or has no message field — this is
 * what turns an opaque "POST /patients failed: 400" into the real
 * validation reason (e.g. "phone must be a valid 10-digit number").
 */
async function extractErrorMessage(response, endpoint, method) {
  let serverMessage = null;
  try {
    const data = await response.clone().json();
    serverMessage = data?.message || data?.error || (Array.isArray(data?.errors) ? data.errors.join(', ') : null);
  } catch (_) {
    // response body wasn't JSON — fall through to status-only message
  }
  return serverMessage
    ? `${method} ${endpoint} failed (${response.status}): ${serverMessage}`
    : `${method} ${endpoint} failed: ${response.status}`;
}

/**
 * Generic GET request.
 * @param {string} endpoint - e.g. '/patients'
 * @returns {Promise<any>}
 */
async function apiGet(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  if (!response.ok) throw new Error(await extractErrorMessage(response, endpoint, 'GET'));
  return response.json();
}

/**
 * Generic POST request.
 * @param {string} endpoint - e.g. '/appointments'
 * @param {object} body - Request payload
 * @returns {Promise<any>}
 */
async function apiPost(endpoint, body) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await extractErrorMessage(response, endpoint, 'POST'));
  return response.json();
}

/**
 * Generic PUT request.
 * @param {string} endpoint - e.g. '/patients/P001'
 * @param {object} body - Updated payload
 * @returns {Promise<any>}
 */
async function apiPut(endpoint, body) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await extractErrorMessage(response, endpoint, 'PUT'));
  return response.json();
}

/**
 * Generic PATCH request.
 * @param {string} endpoint - e.g. '/billing/INV001/payment'
 * @param {object} body - Partial update payload
 * @returns {Promise<any>}
 */
async function apiPatch(endpoint, body) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await extractErrorMessage(response, endpoint, 'PATCH'));
  return response.json();
}

/**
 * Generic DELETE request.
 * @param {string} endpoint - e.g. '/invoices/INV-2847'
 * @returns {Promise<any>}
 */
async function apiDelete(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  if (!response.ok) throw new Error(await extractErrorMessage(response, endpoint, 'DELETE'));
  return response.json();
}

/*
  PLANNED ENDPOINTS (connect in Phase 2.0):

  Patients:      GET  /patients         POST /patients
                 GET  /patients/:id     PUT  /patients/:id

  Appointments:  GET  /appointments     POST /appointments
                 PUT  /appointments/:id

  Doctors:       GET  /doctors          POST /doctors
                 PUT  /doctors/:id

  Invoices:      GET  /invoices         POST /invoices
                 PUT  /invoices/:id     DELETE /invoices/:id

  Calendar:      GET  /events           POST /events

  Reports:       GET  /reports/performance
                 GET  /reports/revenue

  Dashboard:     GET  /dashboard            (Phase 9.0 — live)
*/