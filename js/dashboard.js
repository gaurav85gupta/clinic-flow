/* ============================================================
   DASHBOARD.JS — Operations Command Center (Phase D2)
   Phase 14.3 — Dashboard Visibility Integration on top of D2/D3-D6.
   Pulls live data from GET /api/dashboard, /api/dashboard/revenue,
   /api/reports/appointments, /api/billing/summary, and
   /api/dashboard/activity, rendering the KPI strip, today's
   appointments, doctor roster, revenue chart + stats, department
   performance, recent activity feed, and upcoming schedule.
   No mock data anywhere — every widget shows a real empty state
   ("No revenue available yet.", "No recent activity yet.", etc.)
   when its backing collection has nothing to show, rather than a
   fabricated chart or fixture array.

   ONE Dashboard, MULTIPLE data views: this file still renders a
   single markup structure (dashboard.html) for every role — nothing
   here branches on role to build a different DOM. What changes is
   only which data comes back from the API (now Visibility-Engine-
   scoped server-side, see server.js Phase 14.3) and, for widgets that
   don't apply to a role at all (e.g. Revenue for a receptionist),
   whether that widget's card is present in the DOM at all. Both
   inputs come from the SAME source: `data.visibility`, the object
   GET /api/dashboard now returns (serialized from
   visibilityEngine.getDashboardVisibility(req.user) + getVisibilityContext()
   on the backend) — never a client-side `if (role === 'doctor')`
   check. See applyDashboardVisibility() below.
   ============================================================ */

// Holds the most recently rendered dashboard payload so Export can
// reuse exactly what's on screen ("Export exactly what is currently
// visible" — Phase 12.2), rather than re-querying and risking a
// mismatch with what the user is actually looking at.
let _lastDashboardData = null;
let _lastDeptPerformance = null;
let _lastMonthlyRevenue = null;
let _lastRecentActivity = null;
let _lastPendingTasks = null;

// Phase 14.3 — the Visibility Engine's per-widget verdict for the
// current user, exactly as returned by GET /api/dashboard's
// `data.visibility` field. Populated once loadDashboard() resolves;
// every other widget loader/render function reads from this rather
// than re-deriving its own role check, so there is exactly one
// place in the frontend that knows "what does this role's dashboard
// look like" — matching the one place (visibilityEngine.js) that
// knows it on the backend.
let _dashboardVisibility = null;

document.addEventListener('DOMContentLoaded', () => {
  initLayout('dashboard');
  // Phase 13.2 — wait for the permission guard before loading any
  // data. If the user lacks dashboard.view, initLayout() has already
  // replaced <main> with the Access Denied screen; firing these calls
  // anyway would just be wasted requests against a page that no
  // longer has the DOM elements they write into.
  window._appPageGuardReady.then(async allowed => {
    if (!allowed) return;
    moveHeaderActionsIntoTopbar();
    // Phase 14.3 — loadDashboard() must resolve BEFORE the other
    // widget loaders fire, because it's the call that populates
    // _dashboardVisibility (from the /api/dashboard response's
    // `visibility` field) that every other widget below now checks
    // before deciding whether to even request its own data. This is
    // the one deliberate ordering change from D2 — everything after
    // it is unchanged in sequence.
    await loadDashboard();
    applyDashboardVisibility();
    applyDashboardPermissions();

    const dv = _dashboardVisibility;
    // Each loader below is skipped outright (not just hidden after
    // the fact) when the Visibility Engine says this role can't see
    // that widget's data — avoids a wasted request against a route
    // that would just return an empty/denied payload, and avoids a
    // "Loading…" placeholder flashing before removal.
    if (dv?.widgets?.appointments?.visible !== false) {
      // Department Performance and the mini calendar are appointment-
      // flavoured, clinic-operational widgets. Department Performance
      // reads /api/reports/appointments (a Reports-module,
      // clinic-wide-by-design endpoint — see loadDeptPerformance()
      // header comment) so it only makes sense for roles with
      // clinic-wide or operational appointment visibility.
      if (dv?.canViewOperational !== false) loadDeptPerformance();
      renderMiniCalendar();
      initQueueWidget();
    }
    if (dv?.widgets?.revenue?.visible !== false) {
      loadMonthlyRevenue();
      loadRevenueChart('weekly');
      initRevenueChartTabs();
    }
    // Recent Activity and Pending Tasks are always requested — both
    // routes now self-scope server-side (see server.js
    // activityVisibilityFilter() / allowedTaskCategories()) and
    // degrade to an empty list rather than a denial, so there's
    // nothing for the frontend to pre-check here beyond what the
    // empty-state rendering already handles.
    loadRecentActivity();
    loadPendingTasks();
    initDashboardExport();
    if (dv?.canViewOperational !== false) initDoctorPerformanceWidget();
  });
});

/* ============================================================
   DASHBOARD DATA VISIBILITY (Phase 14.3)
   Consumes `data.visibility` from GET /api/dashboard — the frontend
   NEVER computes its own role -> widget mapping; it only reads the
   verdict the Visibility Engine already computed server-side and
   removes/updates DOM accordingly. This replaces the Phase 13.2
   version of this function, which used Permission Engine checks
   (can('billing','view') etc.) as a role proxy — that pattern is
   exactly what the phase spec asks to remove ("Do NOT use hardcoded
   role checks... All decisions must come from Visibility Context").
   ============================================================ */
function applyDashboardVisibility() {
  const dv = _dashboardVisibility;
  if (!dv) return; // loadDashboard() failed — showDashboardError() already ran

  const widgetVisible = (key) => dv.widgets?.[key]?.visible !== false;

  // Revenue Trends chart card + Monthly Revenue KPI — 'revenue' widget
  if (!widgetVisible('revenue')) {
    document.getElementById('revenueChart')?.closest('.card')?.remove();
    document.getElementById('kpiMonthlyRevenue')?.closest('.kpi-card')?.remove();
  }
  // Pending Payments isn't a separate KPI card in the current markup
  // (it's part of the summary object) — nothing to remove here beyond
  // the Monthly Revenue card above; renderKpis() itself no longer
  // prints a value when summary.todaysRevenue is null (see below).

  // Doctor Performance Today + Doctor Availability + Available
  // Doctors KPI — clinic-wide/operational doctor-roster visibility.
  // A doctor role sees only their own row in the roster (server
  // already scopes doctorsToday to one doctor) rather than the whole
  // card being removed, matching "Doctor: My Daily Performance" in
  // the spec — but Doctor Performance Today (the Top-5 ranking
  // widget) and the clinic-wide Available Doctors count genuinely
  // don't apply to a single-doctor view, so those ARE removed.
  if (!dv.canViewOperational) {
    document.querySelector('.doc-perf-widget-card')?.remove();
    document.getElementById('kpiAvailableDoctors')?.closest('.kpi-card')?.remove();
  }

  // Today's Queue — 'appointments' widget. Billing Staff has no
  // appointments visibility per spec ("cannot view clinical records
  // not required for billing"); everyone else keeps the queue,
  // scoped server-side to their own doctorId when applicable.
  if (!widgetVisible('appointments')) {
    document.querySelector('.queue-widget-card')?.remove();
  }

  // Upcoming Schedule — 'schedule' widget. Billing Staff: hidden per
  // spec's Upcoming Schedule matrix ("Billing -> Hidden").
  if (!widgetVisible('schedule')) {
    document.getElementById('upcomingScheduleList')?.closest('.card')?.remove();
  }

  // Recent Activity — server already returns a role-scoped feed
  // (own actions for a doctor, operational/financial entity types for
  // reception/billing, everything for admin — see server.js
  // activityVisibilityFilter()); the card itself stays for every role
  // since every role has SOME activity to see, per spec ("Doctor ->
  // Own activity only" is a filter, not a removal).

  // KPI label adjustments: "Active Patients" and "Today's
  // Appointments" mean "mine" for a doctor, not "the clinic's" — the
  // numbers are already scoped server-side; only the label changes so
  // the number isn't misread as a clinic-wide total.
  if (dv.scope === 'OWN_DATA') {
    const patientsLabel = document.querySelector('#kpiActivePatients')?.closest('.kpi-card')?.querySelector('.kpi-label');
    if (patientsLabel) patientsLabel.textContent = 'My Active Patients';
    const apptsLabel = document.querySelector('#kpiTodayAppts')?.closest('.kpi-card')?.querySelector('.kpi-label');
    if (apptsLabel) apptsLabel.textContent = "My Appointments Today";
    const revLabel = document.querySelector('#kpiMonthlyRevenue')?.closest('.kpi-card')?.querySelector('.kpi-label');
    if (revLabel) revLabel.textContent = 'My Monthly Revenue';
  }
}

/* ============================================================
   DASHBOARD ACTION PERMISSIONS (Phase 13.2, kept alongside Phase 14.3)
   This is deliberately still Permission-Engine-driven (can()/canView())
   — it answers "what can this user DO from the dashboard" (create an
   appointment, export data), which is the Permission Engine's job, not
   the Visibility Engine's. applyDashboardVisibility() above owns "what
   DATA can this user see"; this function owns action affordances only.
   Renamed from applyDashboardWidgetPermissions() (Phase 13.2) to make
   that split explicit now that both run back-to-back.
   ============================================================ */
function applyDashboardPermissions() {
  // Quick Actions — remove individual buttons the role can't use,
  // then drop the whole card if nothing is left.
  const quickActionTargets = {
    'Book Appointment': () => can('appointments', 'create'),
    'Add Patient': () => can('patients', 'create'),
    'Create Invoice': () => can('billing', 'create'),
    'View Reports': () => canView('reports'),
  };
  document.querySelectorAll('.quick-action-btn').forEach(btn => {
    const label = btn.querySelector('span:last-child')?.textContent?.trim();
    const check = quickActionTargets[label];
    if (check && !check()) btn.remove();
  });
  const qaGrid = document.querySelector('.quick-actions-grid');
  if (qaGrid && qaGrid.children.length === 0) {
    qaGrid.closest('.card')?.remove();
  }

  // Export button in the page header
  if (!can('dashboard', 'export')) {
    document.querySelectorAll('.page-header-actions .btn-secondary').forEach(btn => {
      if (btn.textContent.includes('Export')) btn.remove();
    });
  }
  // New Appointment button in the page header
  if (!can('appointments', 'create')) {
    document.querySelector('[onclick="openModal(\'addAppointmentModal\')"]')?.remove();
  }
}

/* Dashboard-only: after the shared topbar (search + notifications +
   profile, injected by initLayout()) is in the DOM, move the Export
   / New Appointment buttons into that same row (before the profile
   block) and drop the now-empty .page-header wrapper. This keeps
   the buttons on the single top row instead of a separate row below
   it, which used to leave a bare gap where the old page greeting
   text was removed from. Scoped to dashboard.js only — other pages
   that call initLayout() are unaffected. */
function moveHeaderActionsIntoTopbar() {
  const actions = document.querySelector('.page-header-actions');
  const topbarActions = document.querySelector('.header-actions');
  if (!actions || !topbarActions) return;
  actions.classList.add('topbar-page-actions');
  topbarActions.insertBefore(actions, topbarActions.firstChild);
  const pageHeader = document.querySelector('.page-header');
  if (pageHeader) pageHeader.remove();
}

async function loadDashboard() {
  try {
    const res = await apiGet('/dashboard');
    _lastDashboardData = res.data;
    // Phase 14.3 — the single source every other widget's visibility
    // decision reads from. See the DOMContentLoaded handler above.
    _dashboardVisibility = res.data.visibility || null;
    renderDashboard(res.data);
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    showDashboardError();
  }
}

function renderDashboard(data) {
  renderKpis(data.summary);
  renderStatusStrip(data.summary);
  renderTodayAppointments(data.todaysAppointments);
  renderDoctorsToday(data.doctorsToday);
  renderUpcoming(data.upcomingAppointments);
}

/* ---------- small render-time helpers ---------- */

// Patients have no stored initials/avatar color (only Doctor does —
// see server.js patientSchema vs doctorSchema). Both are derived
// client-side here, purely for display, and never sent back to the API.
function initialsFromName(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function avatarClassFor(id) {
  const str = String(id || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return 'av-' + ((hash % 6) + 1);
}

// "09:00" (24hr, as stored) -> "9:00 AM"
function formatTime12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// Maps appointment status -> existing badge-status CSS classes
// (same classes appointments.js already uses) + display label.
// 'no_show' reuses the cancelled badge style — no dedicated CSS
// class exists for it yet, and adding one is outside Phase 9.0 scope.
const APPT_BADGE = {
  scheduled: { cls: 'badge-scheduled', label: 'Scheduled' },
  confirmed: { cls: 'badge-confirmed', label: 'Confirmed' },
  waiting: { cls: 'badge-waiting', label: 'Waiting' },
  completed: { cls: 'badge-completed', label: 'Completed' },
  cancelled: { cls: 'badge-cancelled', label: 'Cancelled' },
  no_show: { cls: 'badge-cancelled', label: 'No Show' },
};

function apptBadge(status) {
  return APPT_BADGE[status] || { cls: 'badge-scheduled', label: status };
}

const DOCTOR_BADGE = {
  available: { cls: 'badge-active', label: 'Available' },
  on_leave: { cls: 'badge-inactive', label: 'On Leave' },
  off_today: { cls: 'badge-inactive', label: 'Not Scheduled Today' },
};

function doctorBadge(status) {
  return DOCTOR_BADGE[status] || { cls: 'badge-inactive', label: status };
}

/* ---------- KPI strip ---------- */

function renderKpis(summary) {
  setText('kpiActivePatients', summary.activePatients.toLocaleString('en-US'));
  setText('kpiActivePatientsTrend', 'Registered & active');

  setText('kpiTodayAppts', summary.todaysTotal);
  setText('kpiTodayApptsTrend', `${summary.todaysRemaining} remaining today`);

  setText('kpiAvailableDoctors', `${summary.activeDoctors} / ${summary.totalDoctors}`);
}

function renderStatusStrip(summary) {
  const el = document.getElementById('todayStatusStrip');
  if (!el) return;
  const pills = [
    { label: 'Waiting', count: summary.todaysWaiting, cls: 'badge-waiting' },
    { label: 'Completed', count: summary.todaysCompleted, cls: 'badge-completed' },
    { label: 'Cancelled', count: summary.todaysCancelled, cls: 'badge-cancelled' },
  ];
  el.innerHTML = pills.map(p => `
    <span class="badge-status ${p.cls}">${p.count} ${p.label}</span>
  `).join('');

  const subtitle = document.getElementById('todayApptSubtitle');
  if (subtitle) subtitle.textContent = `${summary.todaysTotal} total · ${summary.todaysRemaining} remaining`;
}

/* ---------- Today's Appointments ---------- */

function renderTodayAppointments(appointments) {
  const el = document.getElementById('todayApptList');
  if (!el) return;

  if (!appointments || appointments.length === 0) {
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No appointments scheduled for today</div>';
    return;
  }

  // Command-center widget, not the full list view (that's appointments.html) —
  // show the next 8 and point to "View all" for the rest.
  el.innerHTML = appointments.slice(0, 8).map(a => {
    const patient = a.patientId || {};
    const doctor = a.doctorId || {};
    const badge = apptBadge(a.status);
    return `
      <div class="appt-item">
        <div class="appt-time">${formatTime12(a.startTime)}</div>
        <div class="table-avatar ${avatarClassFor(patient._id)}">${initialsFromName(patient.fullName)}</div>
        <div class="appt-info">
          <div class="appt-name">${patient.fullName || 'Unknown patient'}</div>
          <div class="appt-doctor">${doctor.fullName || ''}${doctor.specialization ? ' · ' + doctor.specialization : ''}</div>
        </div>
        <span class="badge-status ${badge.cls}">${badge.label}</span>
      </div>
    `;
  }).join('');
}

/* ---------- Doctor Availability ---------- */

function renderDoctorsToday(doctors) {
  const el = document.getElementById('doctorStatusList');
  if (!el) return;

  if (!doctors || doctors.length === 0) {
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No active doctors found</div>';
    return;
  }

  el.innerHTML = doctors.map(d => {
    const badge = doctorBadge(d.status);
    return `
      <div class="doctor-status-item">
        <div class="table-avatar ${d.avatarColor || 'av-1'}">${d.initials || initialsFromName(d.fullName)}</div>
        <div class="flex-1">
          <div class="td-primary" style="font-size:13px">${d.fullName}</div>
          <div class="td-muted">${d.specialization || ''} · ${d.patientsToday} patient${d.patientsToday === 1 ? '' : 's'} today</div>
        </div>
        <span class="badge-status ${badge.cls}">${badge.label}</span>
      </div>
    `;
  }).join('');
}

/* ---------- Upcoming Schedule (sidebar) ---------- */

function renderUpcoming(appointments) {
  const el = document.getElementById('upcomingScheduleList');
  if (!el) return;

  if (!appointments || appointments.length === 0) {
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Nothing left on today\'s schedule</div>';
    return;
  }

  el.innerHTML = appointments.map(a => {
    const patient = a.patientId || {};
    const doctor = a.doctorId || {};
    return `
      <div class="schedule-item" style="border-color: var(--color-secondary-light)">
        <div class="schedule-time">${formatTime12(a.startTime)}</div>
        <div class="schedule-info">
          <div class="schedule-title">${patient.fullName || 'Unknown patient'}</div>
          <div class="schedule-sub">${doctor.fullName || ''}${doctor.specialization ? ' · ' + doctor.specialization : ''}</div>
        </div>
      </div>
    `;
  }).join('');
}

/* ---------- error state ---------- */

function showDashboardError() {
  showToast('Could not load live dashboard data', 'error');
  ['kpiActivePatients', 'kpiTodayAppts', 'kpiAvailableDoctors'].forEach(id => setText(id, '—'));
  ['kpiActivePatientsTrend', 'kpiTodayApptsTrend'].forEach(id => setText(id, 'Unavailable'));
  const today = document.getElementById('todayApptList');
  if (today) today.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Could not load today\'s schedule</div>';
  const doctors = document.getElementById('doctorStatusList');
  if (doctors) doctors.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Could not load doctor roster</div>';
  const upcoming = document.getElementById('upcomingScheduleList');
  if (upcoming) upcoming.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Could not load upcoming schedule</div>';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ---------- Department Performance (real, from /api/reports/appointments) ----------
   Phase 12.5 — byDepartment is grouped by doctor.specialization, whose
   values are now sourced from the Department collection (Settings >
   Departments) rather than free text. If the clinic has configured
   zero departments, this shows a distinct empty state — never a
   fabricated chart. */

async function loadDeptPerformance() {
  const el = document.getElementById('deptBars');
  if (!el) return;
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const params = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) });
    const [apptRes, deptRes] = await Promise.all([
      apiGet(`/reports/appointments?${params}`),
      apiGet('/departments?limit=1').catch(() => null),
    ]);
    if (deptRes && (deptRes.pagination?.total ?? deptRes.data?.length ?? 0) === 0) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No departments found — add departments in Settings to see performance here.</div>';
      return;
    }
    const byDept = (apptRes.data.byDepartment || []).slice(0, 5);
    _lastDeptPerformance = byDept;
    if (!byDept.length) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No appointments recorded this month</div>';
      return;
    }
    const max = Math.max(...byDept.map(d => d.count));
    el.innerHTML = byDept.map(d => `
      <div class="dept-bar-item">
        <div class="dept-bar-label">
          <span>${d.specialization}</span>
          <span class="font-semibold">${d.count}</span>
        </div>
        <div class="dept-bar-track"><div class="dept-bar-fill" style="width:${max ? Math.round((d.count / max) * 100) : 0}%"></div></div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load department performance:', err);
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Could not load department data</div>';
  }
}

/* ---------- Monthly Revenue KPI (real, from /api/billing/summary) ----------
   Phase 14.3 — /api/billing/summary is a SHARED, clinic-wide-by-design
   endpoint (also used by billing.html's own KPI strip) with no
   Visibility Engine scoping of its own — scoping it here would break
   billing.html for billing_staff/clinic_admin, who are meant to see
   the whole clinic's summary there. So for the Dashboard specifically,
   this call is only made when the 'revenue' widget's scope is
   clinic-wide (FULL_CLINIC/FINANCIAL). A doctor's OWN_DATA revenue
   scope instead falls back to the already-doctor-scoped
   summary.todaysRevenue figure from GET /api/dashboard (see
   renderDashboard/renderKpis) — "Monthly" isn't literally available
   per-doctor without a new endpoint, so the KPI clearly labels what it
   is showing rather than silently substituting a different period. */

async function loadMonthlyRevenue() {
  const dv = _dashboardVisibility;
  const isOwnData = dv && dv.widgets?.revenue?.scope === 'OWN_DATA';
  if (isOwnData) {
    // Use the dashboard-scoped daily figure instead of the clinic-wide
    // /billing/summary endpoint — never call a clinic-wide financial
    // endpoint on behalf of a doctor-scoped dashboard.
    const todaysRevenue = _lastDashboardData?.summary?.todaysRevenue;
    setText('kpiMonthlyRevenue', typeof todaysRevenue === 'number' ? formatCurrency(todaysRevenue) : '—');
    setText('kpiMonthlyRevenueTrend', "Today's revenue (my patients)");
    return;
  }
  try {
    const res = await apiGet('/billing/summary');
    _lastMonthlyRevenue = res.data;
    setText('kpiMonthlyRevenue', formatCurrency(res.data.month.collected || 0));
    setText('kpiMonthlyRevenueTrend', `${res.data.month.count} invoice${res.data.month.count === 1 ? '' : 's'} this month`);
  } catch (err) {
    console.error('Failed to load monthly revenue:', err);
    setText('kpiMonthlyRevenue', '—');
    setText('kpiMonthlyRevenueTrend', 'Unavailable');
  }
}

/* ---------- Mini Calendar (real current month, no event data needed) ---------- */

function renderMiniCalendar() {
  const el = document.getElementById('miniCalendar');
  const titleEl = document.getElementById('miniCalTitle');
  if (!el) return;
  const now = new Date();
  if (titleEl) titleEl.textContent = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const todayDate = now.getDate();

  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  let html = '<div class="mini-cal-grid">' + days.map(d => `<div class="mini-cal-label">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="mini-cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    html += `<div class="mini-cal-cell${d === todayDate ? ' today' : ''}">${d}</div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

/* ---------- Revenue Chart (real, from /api/dashboard/revenue) ----------
   Phase D2 — dashboard-local revenue widget with its own aggregation
   endpoint (server.js section 4I getDashboardRevenue), separate from
   Reports' /api/reports/revenue. Weekly = last 7 calendar days, one
   bar per day, zero-filled. Monthly = last 12 calendar months, one
   bar per month, zero-filled. Bars (not a line) read better for a
   handful of discrete day/month buckets, some of which are
   legitimately zero. Only paymentStatus:'paid' invoices count —
   pending/cancelled/draft never contribute. If the whole window has
   no paid revenue at all, the canvas is hidden and a plain-text
   empty state is shown instead of an empty/flat chart. */

let _revenueChart = null;

function setRevenueChartLoading() {
  const canvas = document.getElementById('revenueChart');
  const emptyEl = document.getElementById('revenueChartEmpty');
  const statsEl = document.getElementById('revenueChartStats');
  if (_revenueChart) { _revenueChart.destroy(); _revenueChart = null; }
  if (canvas) canvas.style.display = 'none';
  if (statsEl) statsEl.style.display = 'none';
  if (emptyEl) { emptyEl.textContent = 'Loading revenue…'; emptyEl.style.display = 'block'; }
}

function renderRevenueStats(stats) {
  const statsEl = document.getElementById('revenueChartStats');
  if (!statsEl) return;
  if (!stats) { statsEl.style.display = 'none'; statsEl.innerHTML = ''; return; }

  const cells = [
    { label: 'Total', value: formatCurrency(stats.total) },
    { label: 'Average', value: formatCurrency(stats.average) },
    { label: 'Highest', value: stats.highest ? formatCurrency(stats.highest.revenue) : '—', sub: stats.highest?.label || '' },
    { label: 'Lowest', value: stats.lowest ? formatCurrency(stats.lowest.revenue) : '—', sub: stats.lowest?.label || '' },
  ];
  statsEl.innerHTML = cells.map((c) => `
    <div style="text-align:center">
      <div style="font-size:10px;font-weight:700;color:var(--color-on-surface-variant);text-transform:uppercase;letter-spacing:0.04em">${c.label}</div>
      <div style="font-family:'Manrope',sans-serif;font-size:15px;font-weight:800;color:var(--color-on-surface);margin-top:2px">${c.value}</div>
      ${c.sub ? `<div style="font-size:10px;color:var(--color-on-surface-variant);margin-top:1px">${c.sub}</div>` : ''}
    </div>
  `).join('');
  statsEl.style.display = 'grid';
}

async function loadRevenueChart(period) {
  const canvas = document.getElementById('revenueChart');
  const emptyEl = document.getElementById('revenueChartEmpty');
  if (!canvas) return;

  setRevenueChartLoading();

  try {
    const res = await apiGet(`/dashboard/revenue?period=${period === 'monthly' ? 'monthly' : 'weekly'}`);
    const trend = res.data.trend || [];
    const stats = res.data.stats || null;
    const hasRevenue = trend.some((t) => t.revenue > 0);

    if (_revenueChart) { _revenueChart.destroy(); _revenueChart = null; }

    if (!hasRevenue) {
      canvas.style.display = 'none';
      if (emptyEl) { emptyEl.textContent = 'No revenue available yet.'; emptyEl.style.display = 'block'; }
      renderRevenueStats(null);
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    canvas.style.display = '';

    const ctx = canvas.getContext('2d');
    _revenueChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: trend.map((t) => t.label),
        datasets: [{
          label: 'Revenue',
          data: trend.map((t) => t.revenue),
          backgroundColor: '#2EBD85',
          hoverBackgroundColor: '#25a674',
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: period === 'monthly' ? 28 : 40,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(255,255,255,0.95)', titleColor: '#121c2c', bodyColor: '#52647a',
            borderColor: 'rgba(46,189,133,0.3)', borderWidth: 1, cornerRadius: 10, padding: 12,
            callbacks: { label: (c) => formatCurrency(c.parsed.y) },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974' } },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
            ticks: { font: { family: 'Inter', size: 11 }, color: '#707974', callback: (v) => formatCurrency(v) },
          },
        },
      },
    });

    renderRevenueStats(stats);
  } catch (err) {
    console.error('Failed to load revenue chart:', err);
    if (_revenueChart) { _revenueChart.destroy(); _revenueChart = null; }
    canvas.style.display = 'none';
    if (emptyEl) { emptyEl.textContent = 'Could not load revenue data.'; emptyEl.style.display = 'block'; }
    renderRevenueStats(null);
  }
}

function initRevenueChartTabs() {
  document.querySelectorAll('.chart-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('.chart-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadRevenueChart(btn.dataset.period || 'weekly');
    });
  });
}

/* ---------- Recent Activity (real, from /api/dashboard/activity) ----------
   Phase D1 — AuditLog was write-only from the API's perspective;
   GET /api/dashboard/activity is its first read route (server.js
   section 4I). Phase D3 enriches this feed with a resolved
   description, the actor's role, and date/time alongside relative
   time — see server.js's describeActivity()/getDashboardActivity().
   Shows the clinic's latest audited actions across Patients, Doctors,
   Departments, Appointments, Billing, and Staff. Architecture (single
   GET, client-side rendering into #recentActivityList) is left as-is
   so "View All" / filters / search / infinite scroll / WebSocket
   push can be layered on later without a rewrite. */

// entityType -> one of the .activity-icon color classes already
// defined in dashboard.css (green/blue/orange/teal). Reused rather
// than introducing new hardcoded hex colors — same visual language
// as every other icon badge on this dashboard.
const ACTIVITY_ICON_CLASS = {
  Patient: 'green',
  Doctor: 'orange',
  Appointment: 'blue',
  Invoice: 'teal',
  User: 'orange',
  Department: 'teal',
  Setting: 'neutral',
  Clinic: 'neutral',
};

// Minimal HTML-escape for values interpolated from the API (patient/
// doctor/staff names) so the feed can't be used to inject markup.
function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// "2026-06-30T10:15:00Z" -> "Just now" / "12m ago" / "3h ago" /
// "Yesterday" / "3d ago" / "Jun 28". Computed client-side from
// createdAt so it keeps advancing without a re-fetch.
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "2026-06-30" + "10:15" -> "Jun 30, 2026 · 10:15 AM" (absolute
// date/time shown alongside the relative label per the spec).
function formatAbsoluteDateTime(dateStr, timeStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateLabel = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  if (!timeStr) return dateLabel;
  const [hh, mm] = timeStr.split(':').map(Number);
  const period = hh >= 12 ? 'PM' : 'AM';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${dateLabel} · ${String(hour12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${period}`;
}

function renderRecentActivityLoading(el) {
  el.innerHTML = `
    <div class="activity-item" style="border-bottom:none">
      <div class="text-muted text-sm" style="padding:8px 0">Loading activity…</div>
    </div>`;
}

async function loadRecentActivity() {
  const el = document.getElementById('recentActivityList');
  if (!el) return;

  renderRecentActivityLoading(el);

  try {
    const res = await apiGet('/dashboard/activity?limit=10');
    const logs = res.data || [];
    _lastRecentActivity = logs;

    if (!logs.length) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No recent activity available.</div>';
      return;
    }

    el.innerHTML = logs.map((l) => {
      const colorClass = ACTIVITY_ICON_CLASS[l.entityType] || 'neutral';
      const icon = l.icon || 'history';
      const actorLine = [l.actor ? escHtml(l.actor) : null, l.roleLabel ? escHtml(l.roleLabel) : null]
        .filter(Boolean)
        .join(' · ');
      const relative = timeAgo(l.createdAt);
      const absolute = formatAbsoluteDateTime(l.date, l.time);

      return `
      <div class="activity-item">
        <div class="activity-icon ${colorClass}">
          <span class="material-symbols-outlined icon-filled">${escHtml(icon)}</span>
        </div>
        <div class="activity-body">
          <div class="activity-title">${escHtml(l.title || l.label || '')}</div>
          <div class="activity-desc">${escHtml(l.description || '')}</div>
          ${actorLine ? `<div class="activity-desc">${actorLine}</div>` : ''}
        </div>
        <div class="activity-meta">
          <div class="activity-time" title="${escHtml(absolute)}">${escHtml(relative)}</div>
          <div class="activity-time">${escHtml(absolute)}</div>
        </div>
      </div>
    `;
    }).join('');
  } catch (err) {
    console.error('Failed to load recent activity:', err);
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Unable to load recent activity.</div>';
  }
}

/* ---------- Pending Tasks & Alerts (real, from /api/dashboard/tasks) ----------
   Phase D4 — every task/alert on this widget is generated live by one
   of server.js's TASK_GENERATORS (pending appointments, waiting
   patients, pending/overdue invoices, unavailable doctors with
   upcoming appointments, missing departments, missing clinic info,
   inactive staff, system warnings). This file only renders whatever
   the API returns — it has no knowledge of task types or their
   thresholds, so a new generator added server-side (Medicine Stock
   Alerts, License Expiry, etc.) shows up here with zero frontend
   changes, as long as it returns the same
   {type,title,description,priority,count,action} shape. */

function renderPendingTasksLoading(el) {
  el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Loading tasks…</div>';
}

async function loadPendingTasks() {
  const el = document.getElementById('pendingTasksList');
  if (!el) return;

  renderPendingTasksLoading(el);

  try {
    const res = await apiGet('/dashboard/tasks');
    const tasks = res.data || [];
    _lastPendingTasks = tasks;

    if (!tasks.length) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Everything looks good today.</div>';
      return;
    }

    el.innerHTML = tasks.map((t) => {
      const priority = (t.priority || 'low').toLowerCase();
      const actionHref = t.action?.href || '#';
      const actionLabel = t.action?.label || 'View';
      return `
      <div class="task-card priority-${escHtml(priority)}">
        <div class="task-card-body">
          <div class="task-card-title-row">
            <span class="task-card-title">${escHtml(t.title)}</span>
            <span class="task-card-count">${escHtml(String(t.count ?? ''))}</span>
            <span class="badge-status badge-priority-${escHtml(priority)}">${escHtml(priority)}</span>
          </div>
          <div class="task-card-desc">${escHtml(t.description || '')}</div>
        </div>
        <div class="task-card-action">
          <a class="btn btn-secondary btn-sm" href="${escHtml(actionHref)}">${escHtml(actionLabel)}</a>
        </div>
      </div>
    `;
    }).join('');
  } catch (err) {
    console.error('Failed to load pending tasks:', err);
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Unable to load pending tasks.</div>';
  }
}

/* ============================================================
   QUICK "NEW APPOINTMENT" MODAL (dashboard) — real submission flow
   POST /api/appointments — same shape as appointments.js's New
   Appointment form. Doctor list fetched fresh on open (dashboard
   has no other reason to preload it); patient resolved via search.
   ============================================================ */

let _dashApptDoctors = [];
let _dashPatientSearchDebounce = null;

document.addEventListener('DOMContentLoaded', () => {
  initDashboardApptModal();
});

function initDashboardApptModal() {
  const searchInput = document.getElementById('dashApptPatientSearch');
  searchInput?.addEventListener('input', () => {
    document.getElementById('dashApptPatientId').value = '';
    clearTimeout(_dashPatientSearchDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      document.getElementById('dashApptPatientResults').style.display = 'none';
      return;
    }
    _dashPatientSearchDebounce = setTimeout(() => runDashApptPatientSearch(q), 250);
  });

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('dashApptPatientResults');
    if (wrap && !e.target.closest('#dashApptPatientResults') && e.target.id !== 'dashApptPatientSearch') {
      wrap.style.display = 'none';
    }
  });

  // See appointments.js for why this is needed: without it, clicking
  // "Add as new patient" replaces the dropdown's innerHTML mid-click,
  // the click target becomes detached, and the handler above closes
  // the dropdown before the inline add-patient form can stay open.
  document.getElementById('dashApptPatientResults')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.querySelectorAll('[onclick*="openModal(\'addAppointmentModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetDashboardApptForm);
  });
}

async function runDashApptPatientSearch(q) {
  const resultsEl = document.getElementById('dashApptPatientResults');
  try {
    const res = await apiGet(`/patients?search=${encodeURIComponent(q)}&limit=8`);
    const patients = res.data || [];
    const addNewRow = `
      <div class="psr-item psr-add-new" onclick="openInlineNewPatientDash('${q.replace(/'/g, "\\'")}')">
        <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px">person_add</span>
        Add "${q}" as a new patient
      </div>
    `;
    resultsEl.innerHTML = (patients.length
      ? patients.map(p => `
          <div class="psr-item" onclick="selectDashApptPatient('${p._id}', '${(p.fullName || '').replace(/'/g, "\\'")}')">
            ${p.fullName || 'Unknown'} <span class="text-muted" style="font-size:11px">${p.patientId || ''}</span>
          </div>
        `).join('')
      : `<div class="psr-empty">No matching patients</div>`) + addNewRow;
    resultsEl.style.display = 'block';
  } catch (err) {
    console.error('Patient search failed:', err);
    resultsEl.innerHTML = `<div class="psr-empty">Search failed</div>`;
    resultsEl.style.display = 'block';
  }
}

function selectDashApptPatient(id, name) {
  document.getElementById('dashApptPatientId').value = id;
  document.getElementById('dashApptPatientSearch').value = name;
  document.getElementById('dashApptPatientResults').style.display = 'none';
}

async function loadDoctorsForDashAppt() {
  const select = document.getElementById('dashApptDoctorId');
  if (!select) return;
  try {
    const res = await apiGet('/doctors?limit=100');
    _dashApptDoctors = res.data || [];
    select.innerHTML = '<option value="">Select doctor…</option>' +
      _dashApptDoctors.map(d => `<option value="${d._id}">${d.fullName}${d.specialization ? ' — ' + d.specialization : ''}</option>`).join('');
  } catch (err) {
    console.error('Failed to load doctors for appointment form:', err);
    select.innerHTML = '<option value="">Could not load doctors</option>';
  }
}

function resetDashboardApptForm() {
  document.getElementById('dashApptPatientSearch').value = '';
  document.getElementById('dashApptPatientId').value = '';
  document.getElementById('dashApptPatientResults').style.display = 'none';
  document.getElementById('dashApptStartTime').value = '09:00';
  document.getElementById('dashApptEndTime').value = '09:30';
  document.getElementById('dashApptType').value = 'Consultation';
  document.getElementById('dashApptNotes').value = '';
  const iso = new Date().toISOString().slice(0, 10);
  document.getElementById('dashModalDate').value = iso;
  hideDashApptError();
  loadDoctorsForDashAppt();
}

function showDashApptError(msg) {
  const el = document.getElementById('dashApptError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideDashApptError() {
  const el = document.getElementById('dashApptError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function submitDashboardAppointment() {
  hideDashApptError();
  const patientId = document.getElementById('dashApptPatientId').value;
  const doctorId = document.getElementById('dashApptDoctorId').value;
  const appointmentDate = document.getElementById('dashModalDate').value;
  const startTime = document.getElementById('dashApptStartTime').value;
  const endTime = document.getElementById('dashApptEndTime').value;
  const type = document.getElementById('dashApptType').value;
  const notes = document.getElementById('dashApptNotes').value;

  if (!patientId) return showDashApptError('Please select a patient from the search results.');
  if (!doctorId) return showDashApptError('Please select a doctor.');
  if (!appointmentDate) return showDashApptError('Please select a date.');
  if (!startTime || !endTime) return showDashApptError('Please set start and end time.');
  if (startTime >= endTime) return showDashApptError('Start time must be before end time.');

  const payload = { patientId, doctorId, appointmentDate, startTime, endTime, type, notes };

  const btn = document.getElementById('dashApptSubmitBtn');
  btn.disabled = true;
  try {
    await apiPost('/appointments', payload);
    showToast('Appointment booked successfully!');
    closeModal('addAppointmentModal');
    loadDashboard();
  } catch (err) {
    console.error('Failed to book appointment:', err);
    showDashApptError(err.message || 'Could not book appointment. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}
/* ============================================================
   INLINE QUICK-ADD PATIENT (dashboard's quick New Appointment modal)
   Same pattern as appointments.js / calendar.js. POST /api/patients.
   ============================================================ */

function openInlineNewPatientDash(prefillName) {
  const resultsEl = document.getElementById('dashApptPatientResults');
  resultsEl.innerHTML = `
    <div class="psr-inline-form">
      <input class="form-input" id="inlineNewPatNameDash" placeholder="Full name" value="${prefillName.replace(/"/g, '&quot;')}" style="margin-bottom:6px">
      <input class="form-input" id="inlineNewPatPhoneDash" placeholder="Phone number" style="margin-bottom:6px">
      <div id="inlineNewPatErrorDash" class="text-sm" style="color:var(--color-error);display:none;margin-bottom:6px"></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="document.getElementById('dashApptPatientResults').style.display='none'">Cancel</button>
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="submitInlineNewPatientDash()">Save & Select</button>
      </div>
    </div>
  `;
  resultsEl.style.display = 'block';
  document.getElementById('inlineNewPatPhoneDash').focus();
}

async function submitInlineNewPatientDash() {
  const nameEl = document.getElementById('inlineNewPatNameDash');
  const phoneEl = document.getElementById('inlineNewPatPhoneDash');
  const errEl = document.getElementById('inlineNewPatErrorDash');
  const fullName = nameEl.value.trim();
  const phone = phoneEl.value.trim();

  errEl.style.display = 'none';
  if (!fullName) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
  if (!phone) { errEl.textContent = 'Phone number is required.'; errEl.style.display = 'block'; return; }

  try {
    const res = await apiPost('/patients', { fullName, phone, gender: 'Other' });
    const newPatient = res.data;
    showToast('Patient registered and selected');
    selectDashApptPatient(newPatient._id, newPatient.fullName);
  } catch (err) {
    console.error('Failed to quick-add patient:', err);
    errEl.textContent = err.message || 'Could not save patient. Please check the details.';
    errEl.style.display = 'block';
  }
}
/* ---------- Export (Phase 12.2) ----------
   Exports exactly what's currently visible on the dashboard — the KPI
   strip, today's appointments, doctor availability, revenue summary,
   and upcoming schedule — reusing the same data already rendered
   rather than re-querying. If a section hasn't loaded yet, it's
   omitted rather than blocking the whole export. */
function initDashboardExport() {
  initExportButton({
    buttonSelector: '.page-header-actions .btn-secondary',
    title: 'Dashboard Summary',
    getFilenameBase: () => `Dashboard_Summary_${exportFmtDateStamp()}`,
    supportsScope: false,
    buildRows: async () => {
      const rows = [];
      const clinicName = window._appClinicName || 'Clinic';

      rows.push(['Clinic Information', clinicName, '', '']);
      rows.push(['', '', '', '']);

      const s = _lastDashboardData?.summary;
      if (s) {
        rows.push(['Dashboard KPIs', '', '', '']);
        rows.push(['Active Patients', s.activePatients, '', '']);
        rows.push(["Today's Appointments", s.todaysTotal, 'Remaining', s.todaysRemaining]);
        rows.push(['Available Doctors', `${s.activeDoctors} / ${s.totalDoctors}`, '', '']);
        rows.push(['', '', '', '']);
      }

      if (_lastMonthlyRevenue) {
        rows.push(['Revenue Summary', '', '', '']);
        rows.push(['Monthly Revenue', formatCurrency(_lastMonthlyRevenue.month?.collected || 0), 'Invoices', _lastMonthlyRevenue.month?.count ?? '']);
        rows.push(["Today's Collection", formatCurrency(_lastMonthlyRevenue.today?.collected || 0), '', '']);
        rows.push(['', '', '', '']);
      }

      const todays = _lastDashboardData?.todaysAppointments || [];
      if (todays.length) {
        rows.push(["Today's Appointments", '', '', '']);
        rows.push(['Time', 'Patient', 'Doctor', 'Status']);
        todays.forEach(a => {
          rows.push([
            formatTime12(a.startTime),
            a.patientId?.fullName || 'Unknown patient',
            a.doctorId?.fullName || '',
            (a.status || '').replace(/_/g, ' '),
          ]);
        });
        rows.push(['', '', '', '']);
      }

      const doctorsToday = _lastDashboardData?.doctorsToday || [];
      if (doctorsToday.length) {
        rows.push(['Doctor Availability', '', '', '']);
        rows.push(['Doctor', 'Department', 'Patients Today', 'Status']);
        doctorsToday.forEach(d => {
          rows.push([d.fullName, d.specialization || '', d.patientsToday, doctorBadge(d.status).label]);
        });
        rows.push(['', '', '', '']);
      }

      const upcoming = _lastDashboardData?.upcomingAppointments || [];
      if (upcoming.length) {
        rows.push(['Upcoming Schedule', '', '', '']);
        rows.push(['Time', 'Patient', 'Doctor', '']);
        upcoming.forEach(a => {
          rows.push([formatTime12(a.startTime), a.patientId?.fullName || 'Unknown patient', a.doctorId?.fullName || '', '']);
        });
      }

      const headers = ['Field', 'Value', 'Detail', 'Detail'];
      return { headers, rows, sheetName: 'Dashboard' };
    },
  });
}

/* ============================================================
   TODAY'S QUEUE (Phase D5)
   All data from GET /api/dashboard/queue — see server.js
   getDashboardQueue(). No mock queue, no hardcoded names/statuses;
   filters are populated from GET /doctors and GET /departments,
   same pattern appointments.js loadFilterDropdowns() already uses.

   Status display mapping (reuses the real Appointment enum — see
   server.js comment on getDashboardQueue for why no dashboard-only
   statuses were introduced):
     scheduled -> "Scheduled"
     confirmed -> "Checked In"
     waiting   -> "Waiting"
     completed -> excluded from the active queue (still counted in
                  the summary strip)
     cancelled / no_show -> excluded from the active queue (still
                  counted in the summary strip)
   ============================================================ */

let _queueRefreshTimer = null;
let _lastQueueData = null;

const QUEUE_STATUS_DISPLAY = {
  scheduled: { label: 'Scheduled', cls: 'badge-scheduled' },
  confirmed: { label: 'Checked In', cls: 'badge-confirmed' },
  waiting: { label: 'Waiting', cls: 'badge-waiting' },
};

function queueStatusDisplay(status) {
  return QUEUE_STATUS_DISPLAY[status] || { label: status, cls: 'badge-scheduled' };
}

async function initQueueWidget() {
  // Phase 14.3 — a doctor's queue is always their own (server forces
  // this regardless of any ?doctorId= param, see getDashboardQueue()).
  // The "filter by doctor/department" controls only make sense for a
  // role with a clinic-wide or operational view of the queue; for a
  // doctor they'd just be dead UI on top of a single-doctor list, so
  // they're hidden rather than shown-but-pointless. Driven by
  // _dashboardVisibility (canViewOperational), not a role check.
  const dv = _dashboardVisibility;
  const filtersEl = document.querySelector('.queue-filters');
  if (dv && !dv.canViewOperational && filtersEl) {
    filtersEl.remove();
  } else {
    await loadQueueFilters();
  }
  loadQueue();

  const docSel = document.getElementById('queueDoctorFilter');
  const deptSel = document.getElementById('queueDeptFilter');
  if (docSel) docSel.addEventListener('change', loadQueue);
  if (deptSel) deptSel.addEventListener('change', loadQueue);

  // Phase D5 asks the API to be "easily upgradeable to polling or
  // WebSocket without redesign." This is that upgrade path's first
  // step: a plain interval poll using the server's own
  // refreshHintSeconds, calling the exact same loadQueue() a manual
  // filter change already calls — no separate code path to keep in
  // sync. Swapping this for a WebSocket subscription later only
  // means replacing this one setInterval call with a socket
  // handler that also calls loadQueue()/renderQueue().
  if (_queueRefreshTimer) clearInterval(_queueRefreshTimer);
  _queueRefreshTimer = setInterval(loadQueue, 30000);
}

async function loadQueueFilters() {
  const docSel = document.getElementById('queueDoctorFilter');
  const deptSel = document.getElementById('queueDeptFilter');
  if (!docSel && !deptSel) return;
  try {
    const [doctorsRes, deptsRes] = await Promise.all([
      docSel ? apiGet('/doctors?limit=100&isActive=true') : Promise.resolve({ data: [] }),
      deptSel ? apiGet('/departments?isActive=true&limit=100').catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
    ]);
    if (docSel) {
      const doctors = doctorsRes.data || [];
      docSel.innerHTML = '<option value="">All Doctors</option>' +
        doctors.map(d => `<option value="${d._id}">${d.fullName}</option>`).join('');
    }
    if (deptSel) {
      const depts = deptsRes.data || [];
      deptSel.innerHTML = '<option value="">All Departments</option>' +
        depts.map(dep => `<option value="${dep.name}">${dep.name}</option>`).join('');
    }
  } catch (err) {
    console.error('Failed to load queue filters:', err);
  }
}

async function loadQueue() {
  const listEl = document.getElementById('queueList');
  const stripEl = document.getElementById('queueSummaryStrip');
  const subtitleEl = document.getElementById('queueSubtitle');

  try {
    const doctorId = document.getElementById('queueDoctorFilter')?.value || '';
    const department = document.getElementById('queueDeptFilter')?.value || '';
    const params = new URLSearchParams();
    if (doctorId) params.set('doctorId', doctorId);
    if (department) params.set('department', department);
    const qs = params.toString();

    const res = await apiGet(`/dashboard/queue${qs ? '?' + qs : ''}`);
    _lastQueueData = res.data;
    renderQueueSummary(res.data.summary);
    renderQueueList(res.data.queue);
    if (subtitleEl) {
      const activeCount = res.data.queue.length;
      subtitleEl.textContent = activeCount
        ? `${activeCount} patient${activeCount === 1 ? '' : 's'} in the active queue`
        : 'Queue is clear';
    }
  } catch (err) {
    console.error('Failed to load queue:', err);
    if (listEl) listEl.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Could not load today\'s queue</div>';
    if (stripEl) stripEl.innerHTML = '';
    if (subtitleEl) subtitleEl.textContent = 'Unavailable';
  }
}

function renderQueueSummary(summary) {
  const el = document.getElementById('queueSummaryStrip');
  if (!el || !summary) return;
  const pills = [
    { key: 'waiting', label: 'Waiting', cls: 'qs-waiting' },
    { key: 'confirmed', label: 'Checked In', cls: 'qs-checkedin' },
    { key: 'scheduled', label: 'Scheduled', cls: '' },
    { key: 'completed', label: 'Completed', cls: 'qs-completed' },
    { key: 'cancelled', label: 'Cancelled', cls: 'qs-cancelled' },
    { key: 'no_show', label: 'No Show', cls: 'qs-noshow' },
  ];
  el.innerHTML = pills.map(p => `
    <div class="queue-summary-pill ${p.cls}">
      <div class="qs-num">${summary[p.key] ?? 0}</div>
      <div class="qs-label">${p.label}</div>
    </div>
  `).join('');
}

function formatWaitingTime(minutes) {
  if (!minutes || minutes <= 0) return 'Just arrived';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function renderQueueList(queue) {
  const el = document.getElementById('queueList');
  if (!el) return;

  if (!queue || queue.length === 0) {
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No patients in today\'s queue.</div>';
    return;
  }

  el.innerHTML = queue.map(item => {
    const patient = item.patient || {};
    const doctor = item.doctor || {};
    const badge = queueStatusDisplay(item.status);
    const waitCls = item.waitingMinutes > 30 ? 'qw-overdue' : '';

    // Priority flags are prepared here per spec ("prepare the
    // layout... future-ready") but never rendered visible today —
    // server.js always returns false for all three until a future
    // phase adds the underlying Patient/Appointment fields.
    const flags = `
      <span class="queue-priority-flag qp-emergency" title="Emergency" style="${item.priority?.emergency ? 'display:flex' : ''}"><span class="material-symbols-outlined" style="font-size:13px">emergency</span></span>
      <span class="queue-priority-flag qp-senior" title="Senior Citizen" style="${item.priority?.senior ? 'display:flex' : ''}"><span class="material-symbols-outlined" style="font-size:13px">elderly</span></span>
      <span class="queue-priority-flag qp-vip" title="VIP" style="${item.priority?.vip ? 'display:flex' : ''}"><span class="material-symbols-outlined" style="font-size:13px">star</span></span>
    `;

    return `
      <div class="queue-item">
        <div class="queue-item-num">${item.queueNumber}</div>
        <div class="queue-item-info">
          <div class="queue-item-name">${patient.name || 'Unknown patient'}${flags}</div>
          <div class="queue-item-meta">${doctor.name || 'Unassigned'}${doctor.specialization ? ' · ' + doctor.specialization : ''} · ${formatTime12(item.startTime)}</div>
        </div>
        <span class="badge-status ${badge.cls}">${badge.label}</span>
        <span class="queue-item-wait ${waitCls}">${formatWaitingTime(item.waitingMinutes)}</span>
        <div class="queue-item-actions">
          <button class="tbl-action-btn" title="Open Appointment" onclick="window.location.href='appointments.html?openAppt=${item.appointmentId}'"><span class="material-symbols-outlined">event</span></button>
          ${patient.id ? `<button class="tbl-action-btn" title="View Patient" onclick="window.location.href='patients.html?openPatient=${patient.id}'"><span class="material-symbols-outlined">person</span></button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

/* ============================================================
   DOCTOR PERFORMANCE TODAY (Phase D6)
   All data from GET /api/dashboard/doctor-performance — see
   server.js getDashboardDoctorPerformance(). No mock rankings, no
   placeholder revenue; ranking key is chosen by the person via
   docPerfSortSelect and sent to the server as ?sortBy=, never
   computed/re-sorted with a hardcoded field on the client.
   ============================================================ */

let _lastDoctorPerformance = null;

const DOC_PERF_AVAILABILITY = {
  available: { cls: 'badge-active', label: 'Available' },
  on_leave: { cls: 'badge-inactive', label: 'On Leave' },
  off_today: { cls: 'badge-inactive', label: 'Not Scheduled Today' },
};

function docPerfAvailabilityBadge(status) {
  return DOC_PERF_AVAILABILITY[status] || { cls: 'badge-inactive', label: status };
}

function initDoctorPerformanceWidget() {
  loadDoctorPerformance();
  const sortSel = document.getElementById('docPerfSortSelect');
  if (sortSel) sortSel.addEventListener('change', loadDoctorPerformance);
}

async function loadDoctorPerformance() {
  const gridEl = document.getElementById('docPerfGrid');
  const subtitleEl = document.getElementById('docPerfSubtitle');
  try {
    const sortBy = document.getElementById('docPerfSortSelect')?.value || 'patients';
    const res = await apiGet(`/dashboard/doctor-performance?sortBy=${encodeURIComponent(sortBy)}`);
    _lastDoctorPerformance = res.data;
    renderDoctorPerformance(res.data.doctors);
    if (subtitleEl) {
      const count = res.data.doctors.length;
      subtitleEl.textContent = count
        ? `Top ${count} doctor${count === 1 ? '' : 's'} by ${sortBy === 'patients' ? 'patients seen' : sortBy === 'revenue' ? 'revenue generated' : 'completed consultations'}`
        : 'No activity yet today';
    }
  } catch (err) {
    console.error('Failed to load doctor performance:', err);
    if (gridEl) gridEl.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Could not load doctor performance</div>';
    if (subtitleEl) subtitleEl.textContent = 'Unavailable';
  }
}

function renderDoctorPerformance(doctors) {
  const el = document.getElementById('docPerfGrid');
  if (!el) return;

  if (!doctors || doctors.length === 0) {
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No doctor activity available today.</div>';
    return;
  }

  el.innerHTML = doctors.map(d => {
    const badge = docPerfAvailabilityBadge(d.availability);
    const nextAppt = d.nextAppointmentTime ? formatTime12(d.nextAppointmentTime) : '—';
    return `
      <div class="doc-perf-card ${d.rank === 1 ? 'rank-1' : ''}">
        <div class="doc-perf-rank">#${d.rank}</div>
        <div class="doc-perf-header">
          <div class="doc-perf-avatar ${d.avatarColor || avatarClassFor(d.doctorId)}">${d.initials || initialsFromName(d.fullName)}</div>
          <div>
            <div class="doc-perf-name">${d.fullName}</div>
            <div class="doc-perf-dept">${d.specialization || ''}</div>
          </div>
        </div>
        <div class="doc-perf-stats">
          <div class="doc-perf-stat">
            <div class="doc-perf-stat-val">${d.patientsToday}</div>
            <div class="doc-perf-stat-lbl">Patients Today</div>
          </div>
          <div class="doc-perf-stat">
            <div class="doc-perf-stat-val">${d.completed}</div>
            <div class="doc-perf-stat-lbl">Completed</div>
          </div>
          <div class="doc-perf-stat doc-perf-revenue">
            <div class="doc-perf-stat-val">${formatCurrency(d.revenue)}</div>
            <div class="doc-perf-stat-lbl">Revenue Today</div>
          </div>
        </div>
        <div class="doc-perf-meta-row">
          <span class="badge-status ${badge.cls}">${badge.label}</span>
          <span>Next: <span class="doc-perf-next">${nextAppt}</span></span>
        </div>
        <div class="doc-perf-actions">
          <button class="tbl-action-btn" title="View Doctor" onclick="window.location.href='doctors.html?openDoctor=${d.doctorId}'"><span class="material-symbols-outlined">badge</span></button>
          <button class="tbl-action-btn" title="View Today's Appointments" onclick="window.location.href='appointments.html?filterDoctor=${encodeURIComponent(d.fullName)}&filterDate=${_lastDoctorPerformance?.date || ''}'"><span class="material-symbols-outlined">event</span></button>
          <button class="tbl-action-btn" title="View Billing" onclick="window.location.href='billing.html'"><span class="material-symbols-outlined">receipt_long</span></button>
        </div>
      </div>
    `;
  }).join('');
}