/* ============================================================
   MEDICORE GLOBAL JS — Shared UI Components
   ============================================================ */

// Full nav definition — kept as a module-level constant so both the
// initial (unfiltered) render and the later permission-filtered
// re-render (Phase 13.2) use the exact same source list.
const ALL_NAV_LINKS = [
  { id: 'dashboard', icon: 'dashboard', label: 'Dashboard', href: 'dashboard.html' },
  { id: 'appointments', icon: 'event', label: 'Appointments', href: 'appointments.html' },
  { id: 'patients', icon: 'group', label: 'Patients', href: 'patients.html' },
  { id: 'doctors', icon: 'stethoscope', label: 'Doctors', href: 'doctors.html' },
  { id: 'calendar', icon: 'calendar_month', label: 'Calendar', href: 'calendar.html' },
  { id: 'billing', icon: 'payments', label: 'Billing', href: 'billing.html' },
  { id: 'reports', icon: 'bar_chart', label: 'Reports', href: 'reports.html' },
  { id: 'settings', icon: 'settings', label: 'Settings', href: 'settings.html' },
];

const PAGE_TITLES = {
  dashboard: { title: 'Dashboard', breadcrumb: 'Overview' },
  appointments: { title: 'Appointments', breadcrumb: 'Manage Appointments' },
  patients: { title: 'Patients', breadcrumb: 'Patient Directory' },
  doctors: { title: 'Doctors', breadcrumb: 'Medical Staff' },
  calendar: { title: 'Calendar', breadcrumb: 'Schedule View' },
  billing: { title: 'Billing', breadcrumb: 'Revenue & Invoices' },
  reports: { title: 'Reports', breadcrumb: 'Analytics & Insights' },
  settings: { title: 'Settings', breadcrumb: 'System Configuration' },
};

// Builds the sidebar <nav> markup for a given (already filtered)
// list of links — pulled out so it can be re-run after permissions
// load without re-injecting the whole sidebar/header shell.
function buildSidebarNavHtml(navLinks, pageId) {
  const mainLinks = navLinks.filter(l => ['dashboard', 'appointments', 'patients', 'doctors', 'calendar'].includes(l.id));
  const financeLinks = navLinks.filter(l => ['billing', 'reports', 'settings'].includes(l.id));

  const renderLink = link => `
    <a href="${link.href}" class="nav-link ${link.id === pageId ? 'active' : ''}" data-label="${link.label}">
      <span class="material-symbols-outlined ${link.id === pageId ? 'icon-filled' : ''}">${link.icon}</span>
      <span>${link.label}</span>
    </a>
  `;

  return `
    ${mainLinks.length ? `<div class="nav-section-label">Main Menu</div>${mainLinks.map(renderLink).join('')}` : ''}
    ${financeLinks.length ? `<div class="nav-section-label">Finance & Reports</div>${financeLinks.map(renderLink).join('')}` : ''}
  `;
}

// Re-renders just the sidebar nav once permissions are known
// (Phase 13.2). Called from initLayout() after loadPermissions()
// resolves. Removing (not hiding) unauthorized links means a user
// can never discover a page via the DOM/dev-tools sidebar markup.
function applySidebarPermissions(pageId) {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;
  const allowedLinks = (typeof filterNavLinksByPermission === 'function')
    ? filterNavLinksByPermission(ALL_NAV_LINKS)
    : ALL_NAV_LINKS; // permissions.js not loaded — fail open to unfiltered nav rather than break the page
  nav.innerHTML = buildSidebarNavHtml(allowedLinks, pageId);
}

// Clears the JWT (index.html/api.js's medicore_token) and returns to
// the login page. Purely client-side — auth is stateless JWT, no
// server-side session to invalidate, matching how api.js reads the
// token (see getAuthToken()).
function logoutUser() {
  localStorage.removeItem('medicore_token');
  window.location.href = 'index.html';
}

// Inject sidebar + header into the page
function initLayout(pageId) {
  const navLinks = ALL_NAV_LINKS;
  const pt = PAGE_TITLES[pageId] || { title: 'Clinic', breadcrumb: '' };

  // Sidebar brand placeholders — filled by loadAppMeta() after API responds
  const sidebarHtml = `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-brand-icon">
          <span class="material-symbols-outlined icon-filled" style="font-size:22px;">medical_services</span>
        </div>
        <div>
          <div class="sidebar-brand-name" id="sidebarBrandName">Loading…</div>
          <div class="sidebar-brand-tagline" id="sidebarBrandTagline">Clinic Management</div>
        </div>
      </div>
      <nav class="sidebar-nav">
        ${buildSidebarNavHtml(navLinks, pageId)}
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-user" id="sidebarUserTrigger">
          <div class="sidebar-avatar" id="sidebarUserInitials">--</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name" id="sidebarUserName">Loading…</div>
            <div class="sidebar-user-role" id="sidebarUserRole">—</div>
          </div>
          <span class="material-symbols-outlined" style="color:rgba(255,255,255,0.5);font-size:18px;">more_vert</span>
        </div>
        <div class="sidebar-user-menu" id="sidebarUserMenu">
          <button class="sidebar-user-menu-item" id="sidebarLogoutBtn">
            <span class="material-symbols-outlined">logout</span> Logout
          </button>
        </div>
      </div>
    </aside>
    <div class="sidebar-overlay" id="sidebarOverlay"></div>
  `;

  const headerHtml = `
    <header class="header">
      <button class="hamburger-btn" id="hamburgerBtn">
        <span class="material-symbols-outlined">menu</span>
      </button>
      <div class="header-title-area">
        <div class="header-page-title">${pt.title}</div>
        <div class="header-breadcrumb"><span id="headerClinicName">…</span> / ${pt.breadcrumb}</div>
      </div>
      <div class="header-search" style="position:relative">
        <span class="material-symbols-outlined search-icon">search</span>
        <input type="text" id="globalSearchInput" placeholder="Search patients, doctors, appointments..." autocomplete="off">
        <div id="globalSearchResults" class="global-search-results" style="display:none"></div>
      </div>
      <div class="header-actions">
        <div class="header-icon-btn" title="Notifications" onclick="showToast('Notifications coming soon', 'info')">
          <span class="material-symbols-outlined">notifications</span>
          <span class="badge"></span>
        </div>
        <div class="header-icon-btn" title="Quick Add" onclick="showToast('Quick Add coming soon', 'info')">
          <span class="material-symbols-outlined">add_circle</span>
        </div>
        <div class="header-profile" id="headerProfileTrigger" style="cursor:pointer;position:relative">
          <div class="profile-avatar" id="headerProfileAvatar">--</div>
          <div>
            <div class="profile-name" id="headerProfileName">Loading…</div>
            <div class="profile-role" id="headerProfileRole">—</div>
          </div>
          <span class="material-symbols-outlined" style="font-size:16px;color:var(--color-on-surface-variant)">expand_more</span>
          <div class="header-profile-menu" id="headerProfileMenu">
            <button class="header-profile-menu-item" id="headerLogoutBtn">
              <span class="material-symbols-outlined">logout</span> Logout
            </button>
          </div>
        </div>
      </div>
    </header>
  `;

  // Inline styles for the global search dropdown — kept here rather
  // than in a CSS file since global.js is the one script every page
  // already loads, and the header markup it injects has nowhere else
  // guaranteed to be styled from.
  if (!document.getElementById('globalSearchStyles')) {
    const style = document.createElement('style');
    style.id = 'globalSearchStyles';
    style.textContent = `
      .global-search-results {
        position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 200;
        background: var(--color-surface, #fff);
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 12px;
        max-height: 380px; overflow-y: auto;
        box-shadow: 0 12px 32px rgba(0,0,0,0.14);
        padding: 6px 0;
      }
      .gsr-section-label {
        font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
        text-transform: uppercase; color: var(--color-on-surface-variant, #707974);
        padding: 8px 14px 4px;
      }
      .gsr-item {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 14px; cursor: pointer; font-size: 13px;
      }
      .gsr-item:hover { background: rgba(0,0,0,0.04); }
      .gsr-avatar {
        display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
        background: var(--color-primary-container, #d4e7e0);
        color: var(--color-primary, #1B4D3E);
        font-size: 12px; font-weight: 700;
      }
      .gsr-primary { font-weight: 600; color: var(--color-on-surface, #121c2c); }
      .gsr-muted { font-size: 11px; color: var(--color-on-surface-variant, #707974); }
      .gsr-empty { padding: 6px 14px 10px; font-size: 12px; color: var(--color-on-surface-variant, #707974); }
    `;
    document.head.appendChild(style);
  }

  // Insert sidebar before body content
  document.body.insertAdjacentHTML('afterbegin', sidebarHtml);

  // Insert header inside .app-container
  const appContainer = document.querySelector('.app-container');
  if (appContainer) {
    appContainer.insertAdjacentHTML('afterbegin', headerHtml);
  }

  // Hamburger toggle — desktop collapses the sidebar to icons-only
  // (persisted so it stays collapsed across page loads), mobile slides
  // it in/out as an overlay. Width is <= 900px at click-time decides
  // which behavior applies, matching the CSS breakpoint below.
  const isMobileSidebar = () => window.innerWidth <= 900;
  if (localStorage.getItem('medicore_sidebar_collapsed') === '1' && !isMobileSidebar()) {
    document.getElementById('sidebar')?.classList.add('collapsed');
    document.querySelector('.app-container')?.classList.add('sidebar-collapsed');
  }
  document.getElementById('hamburgerBtn')?.addEventListener('click', () => {
    if (isMobileSidebar()) {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('open');
    } else {
      const sidebar = document.getElementById('sidebar');
      const collapsed = sidebar.classList.toggle('collapsed');
      document.querySelector('.app-container')?.classList.toggle('sidebar-collapsed', collapsed);
      localStorage.setItem('medicore_sidebar_collapsed', collapsed ? '1' : '0');
    }
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
  });

  // Sidebar-user + header-profile dropdowns (Logout). Both are simple
  // click-to-toggle popovers; clicking anywhere else closes them.
  const sidebarUserTrigger = document.getElementById('sidebarUserTrigger');
  const sidebarUserMenu = document.getElementById('sidebarUserMenu');
  const headerProfileTrigger = document.getElementById('headerProfileTrigger');
  const headerProfileMenu = document.getElementById('headerProfileMenu');

  function closeProfileMenus() {
    sidebarUserMenu?.classList.remove('open');
    headerProfileMenu?.classList.remove('open');
  }

  sidebarUserTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !sidebarUserMenu.classList.contains('open');
    closeProfileMenus();
    if (willOpen) sidebarUserMenu.classList.add('open');
  });
  headerProfileTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !headerProfileMenu.classList.contains('open');
    closeProfileMenus();
    if (willOpen) headerProfileMenu.classList.add('open');
  });
  document.addEventListener('click', closeProfileMenus);

  document.getElementById('sidebarLogoutBtn')?.addEventListener('click', (e) => { e.stopPropagation(); logoutUser(); });
  document.getElementById('headerLogoutBtn')?.addEventListener('click', (e) => { e.stopPropagation(); logoutUser(); });

  initGlobalSearch();

  /* --------------------------------------------------------
     PHASE 13.2 — Permission-aware rendering
     Runs after the sidebar/header shell exists. loadPermissions()
     is memoized (see permissions.js), so this is the only network
     round-trip per page even though loadAppMeta() below also fires
     immediately — the two don't block each other.

     Order matters:
       1. load matrix (network)
       2. filter sidebar (removes links user can't view)
       3. guard THIS page (Access Denied if user can't view pageId's
          own module) — returns false and swaps out <main> if denied
       4. if allowed, strip any data-perm-gated buttons/sections and
          let the page's own DOMContentLoaded (already queued) load
          its data normally
     Exposed as window._appPageAccessGranted so a page's own init
     code (dashboard.js, patients.js, etc.) can check it before
     firing data-loading calls that would just 403 anyway. -------- */
  window._appPageModule = pageId;
  if (typeof initPermissions === 'function') {
    // Separate promise name from permissions.js's internal
    // window._appPermissionsReady (the loadPermissions() in-flight
    // guard) — this one signals "page guard + sidebar filtering done".
    window._appPageGuardReady = initPermissions(pageId, pt.title).then(allowed => {
      window._appPageAccessGranted = allowed;
      applySidebarPermissions(pageId);
      return allowed;
    });
  } else {
    // permissions.js didn't load (shouldn't happen once wired into
    // every HTML file) — fail open so the page isn't silently broken.
    window._appPageAccessGranted = true;
    window._appPageGuardReady = Promise.resolve(true);
  }
}

/* ============================================================
   GLOBAL HEADER SEARCH
   Live dropdown across Patients, Doctors, and Appointments.
   - Patients/Doctors: backend supports GET ?search= directly.
   - Appointments: no /appointments?search= endpoint exists, so
     we first resolve matching patients/doctors by name (small
     limit) and pull their appointments via ?patientId=/?doctorId=,
     deduped by appointment _id. This is why it's a bit slower
     than the patient/doctor buckets — it's piggybacking on two
     extra calls rather than a single dedicated search endpoint.
   Clicking a result navigates to the relevant page, which reads
   ?openPatient= / ?openDoctor= / ?openAppt= on load and opens
   that record's detail modal automatically.
   ============================================================ */

let _globalSearchDebounce = null;
let _globalSearchSeq = 0;

function initGlobalSearch() {
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('globalSearchResults');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    clearTimeout(_globalSearchDebounce);
    const q = input.value.trim();
    if (!q) {
      results.style.display = 'none';
      results.innerHTML = '';
      return;
    }
    results.innerHTML = `<div class="gsr-empty">Searching…</div>`;
    results.style.display = 'block';
    _globalSearchDebounce = setTimeout(() => runGlobalSearch(q), 300);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim() && results.innerHTML) results.style.display = 'block';
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#globalSearchResults') && e.target.id !== 'globalSearchInput') {
      results.style.display = 'none';
    }
  });
  results.addEventListener('click', (e) => e.stopPropagation());
}

async function runGlobalSearch(q) {
  const results = document.getElementById('globalSearchResults');
  const seq = ++_globalSearchSeq; // guards against an older slow request overwriting a newer one
  if (typeof apiGet !== 'function') return;

  try {
    const [patientsRes, doctorsRes] = await Promise.allSettled([
      apiGet(`/patients?search=${encodeURIComponent(q)}&limit=5`),
      apiGet(`/doctors?search=${encodeURIComponent(q)}&limit=5`),
    ]);
    if (seq !== _globalSearchSeq) return; // a newer keystroke already superseded this call

    const patients = patientsRes.status === 'fulfilled' ? (patientsRes.value.data || []) : [];
    const doctors  = doctorsRes.status === 'fulfilled' ? (doctorsRes.value.data || []) : [];

    // Render patients + doctors immediately — appointments need
    // extra round-trips and shouldn't block the fast results.
    renderGlobalSearchResults({ patients, doctors, appointments: null, q });

    // Appointments: piggyback on the matched patients/doctors above
    // (top 3 each, to keep this bounded) since there's no direct
    // appointment-name search endpoint.
    const apptLookups = [
      ...patients.slice(0, 3).map(p => apiGet(`/appointments?patientId=${p._id}&limit=3`).catch(() => null)),
      ...doctors.slice(0, 3).map(d => apiGet(`/appointments?doctorId=${d._id}&limit=3`).catch(() => null)),
    ];
    const apptResults = await Promise.all(apptLookups);
    if (seq !== _globalSearchSeq) return;

    const seen = new Set();
    const appointments = [];
    apptResults.forEach(r => {
      (r?.data || []).forEach(a => {
        if (!seen.has(a._id)) { seen.add(a._id); appointments.push(a); }
      });
    });

    renderGlobalSearchResults({ patients, doctors, appointments: appointments.slice(0, 6), q });
  } catch (err) {
    if (seq !== _globalSearchSeq) return;
    console.error('Global search failed:', err);
    results.innerHTML = `<div class="gsr-empty">Search failed</div>`;
  }
}

function _gsrInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function _gsrApptWhen(a) {
  const d = a.appointmentDate ? new Date(a.appointmentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return [d, a.startTime].filter(Boolean).join(' · ');
}

function renderGlobalSearchResults({ patients, doctors, appointments, q }) {
  const results = document.getElementById('globalSearchResults');
  if (!results) return;

  const esc = s => String(s || '').replace(/'/g, "\\'");
  const sections = [];

  sections.push(`<div class="gsr-section-label">Patients</div>`);
  if (!patients.length) {
    sections.push(`<div class="gsr-empty">No matching patients</div>`);
  } else {
    sections.push(patients.map(p => `
      <div class="gsr-item" onclick="goToPatient('${p._id}')">
        <span class="gsr-avatar">${_gsrInitials(p.fullName)}</span>
        <div><div class="gsr-primary">${p.fullName || 'Unknown'}</div><div class="gsr-muted">${p.patientId || ''}${p.phone ? ' · ' + p.phone : ''}</div></div>
      </div>
    `).join(''));
  }

  sections.push(`<div class="gsr-section-label">Doctors</div>`);
  if (!doctors.length) {
    sections.push(`<div class="gsr-empty">No matching doctors</div>`);
  } else {
    sections.push(doctors.map(d => `
      <div class="gsr-item" onclick="goToDoctor('${d._id}')">
        <span class="gsr-avatar">${d.initials || _gsrInitials(d.fullName)}</span>
        <div><div class="gsr-primary">${d.fullName}</div><div class="gsr-muted">${d.specialization || ''}</div></div>
      </div>
    `).join(''));
  }

  sections.push(`<div class="gsr-section-label">Appointments</div>`);
  if (appointments === null) {
    sections.push(`<div class="gsr-empty">Searching appointments…</div>`);
  } else if (!appointments.length) {
    sections.push(`<div class="gsr-empty">No matching appointments</div>`);
  } else {
    sections.push(appointments.map(a => `
      <div class="gsr-item" onclick="goToAppointment('${a._id}')">
        <span class="gsr-avatar">${a.status === 'cancelled' ? '✕' : '📅'}</span>
        <div><div class="gsr-primary">${a.patientId?.fullName || 'Unknown patient'} — ${a.doctorId?.fullName || 'Unknown doctor'}</div><div class="gsr-muted">${_gsrApptWhen(a)} · ${a.status || ''}</div></div>
      </div>
    `).join(''));
  }

  results.innerHTML = sections.join('');
  results.style.display = 'block';
}

function goToPatient(id) {
  window.location.href = 'patients.html?openPatient=' + encodeURIComponent(id);
}
function goToDoctor(id) {
  window.location.href = 'doctors.html?openDoctor=' + encodeURIComponent(id);
}
function goToAppointment(id) {
  window.location.href = 'appointments.html?openAppt=' + encodeURIComponent(id);
}

// Modal helpers
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

// Toasts
function showToast(message, type = 'success') {
  const colors = {
    success: { bg: 'var(--color-success-container)', color: 'var(--color-success)', icon: 'check_circle' },
    error: { bg: 'var(--color-error-container)', color: 'var(--color-error)', icon: 'error' },
    info: { bg: 'var(--color-info-container)', color: 'var(--color-info)', icon: 'info' },
  };
  const c = colors[type] || colors.success;
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; bottom:24px; right:24px; z-index:9999;
    display:flex; align-items:center; gap:10px;
    background:var(--color-surface); border-radius:12px;
    padding:14px 18px; box-shadow:0 8px 32px rgba(0,0,0,0.12);
    font-size:13px; font-weight:600; color:var(--color-on-surface);
    border-left:4px solid ${c.color};
    animation: slideIn 0.3s ease;
    max-width:320px;
  `;
  toast.innerHTML = `<span class="material-symbols-outlined" style="color:${c.color};font-size:18px;">${c.icon}</span>${message}`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity='0'; toast.style.transition='opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

/* ============================================================
   GLOBAL CURRENCY SYSTEM
   ============================================================ */

const CURRENCY_SYMBOLS = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£',
  AED: 'د.إ', SGD: 'S$', AUD: 'A$', CAD: 'C$',
};

window._appCurrencySymbol = '$';
window._appCurrencyCode   = 'USD';

// Global formatCurrency
window.formatCurrency = function(amount) {
  const num = Number(amount || 0);
  const locale = window._appCurrencyCode === 'INR' ? 'en-IN' : 'en-US';
  return window._appCurrencySymbol + num.toLocaleString(locale);
};

/* ============================================================
   APP META LOADER
   Loads clinic info + settings + logged-in user in one shot.
   Populates:
     • document <title>
     • Sidebar brand name + tagline
     • Header breadcrumb clinic name
     • Header profile name/role/avatar initials
     • Sidebar footer user name/role/initials
     • window._appCurrencySymbol / _appCurrencyCode
     • window._appClinicName  (for dashboard greeting etc.)
     • window._appApptDuration (appointmentDuration in minutes)
   ============================================================ */

async function loadAppMeta() {
  if (typeof apiGet !== 'function') return;

  try {
    // Fire all three requests in parallel
    const [clinicRes, settingsRes, meRes] = await Promise.allSettled([
      apiGet('/clinic'),
      apiGet('/settings'),
      apiGet('/auth/me'),
    ]);

    /* ---- Clinic info ---- */
    if (clinicRes.status === 'fulfilled') {
      const c = clinicRes.value.data;
      const name    = c.name    || 'Clinic';
      const tagline = c.branding?.tagline || 'Clinic Management';

      // Store globally for other modules (e.g. dashboard greeting)
      window._appClinicName = name;

      // Dashboard greeting subtitle (clinic name)
      const cge = document.getElementById('dashboardClinicNameGreeting');
      if (cge) cge.textContent = name;

      // Sidebar brand
      _setText('sidebarBrandName',    name);
      _setText('sidebarBrandTagline', tagline);

      // Header breadcrumb
      _setText('headerClinicName', name);

      // Browser <title>  e.g. "GAURAV — Dashboard"
      const currentTitle = document.title || '';
      document.title = currentTitle.replace(/^[^—]+—/, name + ' —');
    }

    /* ---- Settings (currency + appt duration) ---- */
    if (settingsRes.status === 'fulfilled') {
      const s    = settingsRes.value.data;
      const code = (s.currency || 'USD').toUpperCase();
      window._appCurrencyCode   = code;
      window._appCurrencySymbol = CURRENCY_SYMBOLS[code] || (code + ' ');
      window._appApptDuration   = Number(s.appointmentDuration) || 30;
    }

    /* ---- Logged-in user (JWT /auth/me) ---- */
    if (meRes.status === 'fulfilled') {
      const u = meRes.value.data || meRes.value.user || meRes.value;
      const fullName = u.fullName || u.name || u.username || 'User';
      const role     = u.role
        ? u.role.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
        : 'Staff';
      const initials = _initials(fullName);

      // Sidebar footer
      _setText('sidebarUserName',     fullName);
      _setText('sidebarUserRole',     role);
      _setText('sidebarUserInitials', initials);

      // Header profile
      _setText('headerProfileName',   fullName);
      _setText('headerProfileRole',   role);
      _setText('headerProfileAvatar', initials);

      // Dashboard greeting — only if the element exists on this page
      const greetEl = document.getElementById('dashboardGreetingName');
      if (greetEl) {
        const firstName = fullName.split(' ')[0];
        greetEl.textContent = firstName;
      }
      // Dashboard clinic name in greeting subtitle
      const clinicGreetEl = document.getElementById('dashboardClinicNameGreeting');
      if (clinicGreetEl && window._appClinicName) {
        clinicGreetEl.textContent = window._appClinicName;
      }

      // Store for other modules
      window._appUser = { fullName, role, initials };
    } else {
      // /auth/me failed (session expired?) — show fallback
      _setText('sidebarUserName',     'User');
      _setText('sidebarUserInitials', 'U');
      _setText('headerProfileName',   'User');
      _setText('headerProfileAvatar', 'U');
    }

  } catch (err) {
    console.warn('loadAppMeta failed:', err);
  }
}

function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function _initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/* ============================================================
   APPOINTMENT DURATION HELPER
   Called from appointments.js / calendar.js / dashboard.js when
   a start-time is picked to auto-compute the end time.

   Usage:
     applyApptDuration('newApptStartTime', 'newApptEndTime');
   ============================================================ */
window.applyApptDuration = function(startId, endId) {
  const startEl = document.getElementById(startId);
  const endEl   = document.getElementById(endId);
  if (!startEl || !endEl || !startEl.value) return;

  const [h, m]  = startEl.value.split(':').map(Number);
  const duration = window._appApptDuration || 30;
  const totalMin = h * 60 + m + duration;
  const eh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const em = String(totalMin % 60).padStart(2, '0');
  endEl.value = `${eh}:${em}`;
};

// Auto-load on every page (api.js must load before global.js)
document.addEventListener('DOMContentLoaded', () => {
  loadAppMeta();
});