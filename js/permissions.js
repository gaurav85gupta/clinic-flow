/* ============================================================
   PERMISSIONS.JS — Frontend Permission Engine (Phase 13.2)
   MediCore Clinic Management System

   Loads the logged-in user's role + the clinic's permission matrix
   ONCE per session (in-memory only — no localStorage/sessionStorage,
   per the phase spec), then exposes a single `can(module, action)`
   check that every page/component uses to decide what to render.

   This file does NOT enforce security — server.js (Phase 13.1)
   remains the only real authorization boundary. Everything here is
   UI/UX: hide what the user can't do so they never see a dead end,
   and show a clean Access Denied screen if they navigate somewhere
   they don't have view rights to. A user who bypasses this file
   entirely (dev tools, direct fetch) still gets a 403 from the API.

   Load order requirement: api.js -> permissions.js -> global.js
   (global.js's initLayout() calls guardPageAccess()/renderSidebarNav()
   from here, so this file must exist before initLayout runs.)
   ============================================================ */

// In-memory only. Never written to localStorage/sessionStorage —
// cleared automatically on tab close/refresh, which is fine because
// loadPermissions() re-fetches on every page load anyway.
window._appPermissions = null; // { role, matrix: { [module]: { [action]: bool } } }
window._appPermissionsReady = null; // Promise, so callers can await a single in-flight load

// Every module this app enforces permissions for. Mirrors
// PERMISSION_MODULES in server.js exactly — kept as a flat list here
// (not re-derived from the matrix) so a module temporarily missing
// from a clinic's stored matrix still resolves to "no access" rather
// than "unknown/undefined".
const PERMISSION_MODULES = [
  'dashboard', 'appointments', 'patients', 'doctors', 'calendar',
  'billing', 'reports', 'settings', 'staff', 'departments',
];
const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'manage'];

/* ============================================================
   LOAD — fetches role (auth/me) + matrix (permissions) once,
   memoizes the in-flight promise so simultaneous callers (sidebar
   render + page guard + widget checks, all firing on DOMContentLoaded)
   never trigger duplicate network requests.
   ============================================================ */
function loadPermissions() {
  if (window._appPermissions) return Promise.resolve(window._appPermissions);
  if (window._appPermissionsReady) return window._appPermissionsReady;

  window._appPermissionsReady = (async () => {
    try {
      const [meRes, permRes] = await Promise.allSettled([
        apiGet('/auth/me'),
        apiGet('/permissions'),
      ]);

      const role = meRes.status === 'fulfilled'
        ? (meRes.value.user?.role || meRes.value.data?.role)
        : null;

      const fullMatrix = permRes.status === 'fulfilled'
        ? (permRes.value.data?.matrix || {})
        : {};

      // super_admin has no clinic-scoped matrix entry (see server.js
      // tenantScope/PERMISSION_ROLES) — treat as full access across
      // every module rather than "no access", since super_admin never
      // reaches these clinic-facing pages under normal operation but
      // must not be locked out if it ever does.
      let roleMatrix;
      if (role === 'super_admin') {
        roleMatrix = {};
        PERMISSION_MODULES.forEach(m => {
          roleMatrix[m] = {};
          PERMISSION_ACTIONS.forEach(a => { roleMatrix[m][a] = true; });
        });
      } else {
        roleMatrix = fullMatrix[role] || {};
      }

      window._appPermissions = { role: role || null, matrix: roleMatrix };
    } catch (err) {
      console.warn('loadPermissions failed — defaulting to no access:', err);
      window._appPermissions = { role: null, matrix: {} };
    }
    return window._appPermissions;
  })();

  return window._appPermissionsReady;
}

/* ============================================================
   CAN — the single permission check every page uses.
   Synchronous: reads from the already-loaded in-memory matrix.
   Returns false (never throws) if called before loadPermissions()
   resolves, or for any module/action not present in the matrix —
   "deny by default", matching the backend's own posture.
   ============================================================ */
function can(moduleName, actionName) {
  const perms = window._appPermissions;
  if (!perms) return false;
  return Boolean(perms.matrix?.[moduleName]?.[actionName]);
}

// Convenience — true if the user has ANY access to a module at all
// (used for things like "does this module deserve a sidebar entry",
// where "view" is the meaningful gate, but kept as a named helper so
// call sites read clearly).
function canView(moduleName) {
  return can(moduleName, 'view');
}

/* ============================================================
   SIDEBAR FILTERING
   Called by global.js's initLayout() after building the nav list.
   Removes (not just hides) nav links the user can't view, so no
   empty gaps and no way to "discover" a page via the DOM.
   ============================================================ */
function filterNavLinksByPermission(navLinks) {
  const perms = window._appPermissions;
  // If permissions haven't loaded yet, show nothing rather than
  // everything — briefly empty is safer than briefly over-privileged,
  // and applyPermissionsToPage() re-renders the sidebar the moment
  // loadPermissions() resolves (see initLayout in global.js).
  if (!perms) return [];
  return navLinks.filter(link => canView(link.id));
}

/* ============================================================
   ACCESS DENIED SCREEN
   Reusable full-page component. Replaces <main class="main-content">
   contents entirely — never a broken/empty page, never a flash of
   real content before the redirect.
   ============================================================ */
function renderAccessDenied(moduleLabel) {
  const main = document.querySelector('.main-content');
  if (!main) return;

  const canSeeDashboard = canView('dashboard');

  main.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:70vh;padding:24px">
      <div style="text-align:center;max-width:380px">
        <div style="width:72px;height:72px;border-radius:50%;background:var(--color-error-container,#fbe4e2);display:flex;align-items:center;justify-content:center;margin:0 auto 20px">
          <span class="material-symbols-outlined icon-filled" style="font-size:36px;color:var(--color-error,#b3261e)">lock</span>
        </div>
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:var(--color-on-surface,#121c2c)">Access Denied</h2>
        <p style="margin:0 0 24px;font-size:14px;color:var(--color-on-surface-variant,#707974);line-height:1.5">
          You don't have permission to view${moduleLabel ? ' the ' + moduleLabel + ' module' : ' this page'}.
          Contact your clinic administrator if you believe this is a mistake.
        </p>
        ${canSeeDashboard ? `<a href="dashboard.html" class="btn btn-primary"><span class="material-symbols-outlined">arrow_back</span> Back to Dashboard</a>` : ''}
      </div>
    </div>
  `;
}

/* ============================================================
   PAGE GUARD
   Called once per page (from global.js's initLayout) with the
   module this page represents. If the user lacks view rights,
   replaces the page body with Access Denied and returns false so
   the calling page's own DOMContentLoaded init (data loading, etc.)
   can bail out early instead of firing wasted/failing API calls.
   ============================================================ */
function guardPageAccess(pageModule, moduleLabel) {
  if (!pageModule) return true; // pages with no permission module (e.g. login) are never gated
  if (canView(pageModule)) return true;
  renderAccessDenied(moduleLabel);
  return false;
}

/* ============================================================
   DECLARATIVE BUTTON/SECTION HIDING
   Any element in the DOM can opt into permission-gating by adding
   data-perm="module.action" (or data-perm="module.action1|action2"
   for "any of"). applyPermissionsToPage() removes (not just hides)
   every element the user isn't allowed to see. This covers static
   markup (page header buttons, settings nav items, quick actions)
   without each page needing to hand-write the same check.

   Dynamically-rendered content (table rows built in JS) can't use
   data-perm since it doesn't exist yet at scan time — those call
   can()/canView() directly inside their own render functions
   instead (see patients.js, doctors.js, etc.).
   ============================================================ */
function applyPermissionsToPage() {
  document.querySelectorAll('[data-perm]').forEach(el => {
    const spec = el.getAttribute('data-perm'); // e.g. "patients.create" or "billing.view|edit"
    const [moduleName, actionSpec] = spec.split('.');
    const actions = (actionSpec || 'view').split('|');
    const allowed = actions.some(a => can(moduleName, a));
    if (!allowed) el.remove();
  });

  // Elements that should collapse their parent container if ALL of
  // their children were removed (prevents empty card shells / empty
  // section headers with nothing left underneath).
  document.querySelectorAll('[data-perm-group]').forEach(group => {
    const stillHasChildren = group.querySelector('[data-perm]') || group.children.length > 0;
    if (!stillHasChildren) group.remove();
  });
}

/* ============================================================
   ENTRY POINT
   global.js's initLayout() calls this after building the sidebar,
   and awaits it before calling applyPermissionsToPage() so nothing
   flashes visible-then-removed.
   ============================================================ */
async function initPermissions(pageModule, moduleLabel) {
  await loadPermissions();
  const allowed = guardPageAccess(pageModule, moduleLabel);
  if (allowed) applyPermissionsToPage();
  return allowed;
}
