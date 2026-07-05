/* REPORTS JS — Phase: Hardcoded Data Removal Audit
   Data sources:
     GET /api/reports/overview            — YTD-ish KPI deltas (month over month)
     GET /api/reports/revenue             — revenue trend (12mo) + by-department
     GET /api/reports/patients/growth     — new-patient trend (12mo)
     GET /api/reports/appointments        — status mix, completion/no-show rates
     GET /api/reports/doctors/performance — staff performance table
   No mock PERF_DATA array, no fixture KPI numbers. MongoDB via api.js
   is the single source of truth.

   NOTE: doctorSchema has no `rating` field and no patient-feedback
   collection exists, so "Avg Patient Rating" (KPI) and the star
   rating column (table) have no backend source and have been removed
   rather than faked. "Peak Hours" insight also has no aggregation
   endpoint (no time-of-day bucketing exists) and has been removed.
   See audit report: "Missing endpoints". */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function fmtTrend(pct) {
  if (pct == null) return '';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct}%`;
}

// Snapshots of each report's last successful response, kept so Export
// can reuse exactly what's on screen instead of re-querying (Phase
// 12.2 — "Export generated reports exactly as displayed").
let _lastOverview = null;
let _lastRevenueTrend = null;
let _lastPatientGrowth = null;
let _lastApptStatus = null;
let _lastDeptRevenue = null;
let _lastDoctorPerformance = [];
let _lastInsights = null;

// Resolves the "Last 30 Days / This Month / Custom Range / etc" select
// into an actual { from, to } range for export, since the charts
// underneath don't yet re-fetch per selection. Kept for the PDF export
// (unchanged behavior); the Executive KPI cards use the richer
// currentExecKpiRange() below, which also derives the comparison
// (previous) period.
function currentReportsDateRange() {
  const { from, to } = currentExecKpiRange();
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/* ============================================================
   EXECUTIVE KPI CARDS (Phase R1)
   ============================================================ */

function _dstart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function _dend(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function _isoDate(d) { return d.toISOString().slice(0, 10); }

// Given the selected preset (or custom inputs), returns:
//   { from, to }                 — the currently selected window
//   { prevFrom, prevTo }         — an equal-length window immediately
//                                   preceding it, used for the
//                                   ▲/▼ comparison on every KPI card.
// "This Month" compares to the calendar previous month (not a
// generic 30-day shift) to match how a clinic owner actually thinks
// about month-over-month; every other preset uses a same-length
// preceding window, per the R1 spec's examples (Last 30 Days ->
// Previous 30 Days, Today -> Yesterday).
function currentExecKpiRange() {
  const sel = document.getElementById('reportsDateRangeSelect');
  const val = sel?.value || 'Last 30 Days';
  const now = new Date();

  if (val === 'Custom Range') {
    const fromEl = document.getElementById('reportsCustomFrom');
    const toEl = document.getElementById('reportsCustomTo');
    const from = fromEl?.value ? _dstart(new Date(fromEl.value)) : _dstart(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    const to = toEl?.value ? _dend(new Date(toEl.value)) : _dend(now);
    const spanMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - spanMs);
    return { from, to, prevFrom: _dstart(prevFrom), prevTo: _dend(prevTo) };
  }

  if (val === 'This Month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = _dend(now);
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevTo = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { from: _dstart(from), to, prevFrom: _dstart(prevFrom), prevTo };
  }

  if (val === 'Last Month') {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const prevTo = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59, 999);
    return { from: _dstart(from), to, prevFrom: _dstart(prevFrom), prevTo };
  }

  if (val === 'This Year') {
    const from = new Date(now.getFullYear(), 0, 1);
    const to = _dend(now);
    const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
    const prevTo = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
    return { from: _dstart(from), to, prevFrom: _dstart(prevFrom), prevTo };
  }

  // Today / Last 7 Days / Last 30 Days / Last 90 Days — all
  // same-length-window presets, diffed only by day count.
  const days = { 'Today': 1, 'Last 7 Days': 7, 'Last 90 Days': 90 }[val] || 30;
  const to = _dend(now);
  const from = _dstart(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { from, to, prevFrom: _dstart(prevFrom), prevTo: _dend(prevTo) };
}

// Per-card loader registry so the date-range select and each card's
// own Retry button can re-trigger exactly one card without refetching
// (or blocking on) the other five — "one failed request should not
// stop the others" / "cards should load independently".
const EXEC_KPI_LOADERS = {
  revenue: loadExecKpiRevenue,
  appointments: loadExecKpiAppointments,
  patients: loadExecKpiPatients,
  avgRevenue: loadExecKpiAvgRevenue,
  collection: loadExecKpiCollection,
  outstanding: loadExecKpiOutstanding,
};

function loadExecutiveKpis() {
  Object.keys(EXEC_KPI_LOADERS).forEach(key => retryExecKpi(key));
}

function retryExecKpi(key) {
  const card = document.getElementById('ekCard' + _capFirst(key));
  if (!card) return;
  card.classList.remove('has-error');
  card.classList.add('is-loading');
  EXEC_KPI_LOADERS[key]().then(() => {
    card.classList.remove('is-loading');
  }).catch(err => {
    console.error(`Failed to load KPI [${key}]:`, err);
    card.classList.remove('is-loading');
    card.classList.add('has-error');
  });
}
function _capFirst(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// Trend/comparison arrow markup shared by every KPI card.
function _applyCompare(elId, pct, upIsGood = true) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (pct == null || !isFinite(pct)) {
    el.className = 'exec-kpi-compare neutral';
    el.innerHTML = '<span class="material-symbols-outlined">remove</span> No prior-period data';
    return;
  }
  if (pct === 0) {
    el.className = 'exec-kpi-compare neutral';
    el.innerHTML = '<span class="material-symbols-outlined">remove</span> No change vs previous period';
    return;
  }
  const isUp = pct > 0;
  const cls = isUp === upIsGood ? 'up' : 'down';
  const icon = isUp ? 'arrow_upward' : 'arrow_downward';
  el.className = `exec-kpi-compare ${cls}`;
  el.innerHTML = `<span class="material-symbols-outlined">${icon}</span> ${isUp ? '+' : ''}${pct}% vs previous period`;
}
function _pctChange(curr, prev) {
  if (!prev) return curr ? 100 : (curr === 0 ? 0 : null);
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

let _lastExecKpi = null;

// 1. Total Revenue — /reports/revenue totals.collected, current vs
// previous window (both real MongoDB-aggregated figures).
async function loadExecKpiRevenue() {
  const { from, to, prevFrom, prevTo } = currentExecKpiRange();
  const [curRes, prevRes] = await Promise.all([
    apiGet(`/reports/revenue?${new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) })}`),
    apiGet(`/reports/revenue?${new URLSearchParams({ from: _isoDate(prevFrom), to: _isoDate(prevTo) })}`),
  ]);
  const curr = curRes.data.totals.collected;
  const prev = prevRes.data.totals.collected;
  setText('ekRevenueValue', formatCurrency(curr));
  _applyCompare('ekRevenueCompare', _pctChange(curr, prev));
  setText('ekRevenueFooter', `${_isoDate(from)} to ${_isoDate(to)}`);
  _lastExecKpi = _lastExecKpi || {};
  _lastExecKpi.revenue = { curr, prev };
}

// 2. Total Appointments — /reports/appointments totals.total
// (already "Completed + Pending" + every other status combined).
async function loadExecKpiAppointments() {
  const { from, to, prevFrom, prevTo } = currentExecKpiRange();
  const [curRes, prevRes] = await Promise.all([
    apiGet(`/reports/appointments?${new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) })}`),
    apiGet(`/reports/appointments?${new URLSearchParams({ from: _isoDate(prevFrom), to: _isoDate(prevTo) })}`),
  ]);
  const curr = curRes.data.totals.total;
  const prev = prevRes.data.totals.total;
  setText('ekApptsValue', curr.toLocaleString('en-US'));
  _applyCompare('ekApptsCompare', _pctChange(curr, prev));
  const t = curRes.data.totals;
  setText('ekApptsFooter', `${t.completed} completed · ${curr - t.completed - t.cancelled} pending · ${t.cancelled} cancelled`);
  _lastExecKpi = _lastExecKpi || {};
  _lastExecKpi.appointments = { curr, prev };
}

// 3. Active Patients — clinic-wide count (not range-scoped, since
// "active" is a point-in-time patient status, not a period metric)
// from /reports/patients/growth activeVsInactive.active, with the
// comparison line showing new patients registered in the selected
// window (per the R1 spec: "New patients in selected period").
async function loadExecKpiPatients() {
  const { from, to } = currentExecKpiRange();
  const res = await apiGet(`/reports/patients/growth?${new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) })}`);
  const active = res.data.activeVsInactive?.active || 0;
  const newInRange = (res.data.trend || []).reduce((sum, t) => sum + (t.newPatients || 0), 0);
  setText('ekPatientsValue', active.toLocaleString('en-US'));
  const el = document.getElementById('ekPatientsCompare');
  if (el) {
    el.className = 'exec-kpi-compare up';
    el.innerHTML = `<span class="material-symbols-outlined">person_add</span> +${newInRange} new`;
  }
  setText('ekPatientsFooter', `New patients, ${_isoDate(from)} to ${_isoDate(to)}`);
  _lastExecKpi = _lastExecKpi || {};
  _lastExecKpi.patients = { active, newInRange };
}

// 4. Average Revenue Per Day — derived from the same revenue totals
// as card 1, divided by the number of days in each window (both
// real, no separate endpoint needed).
async function loadExecKpiAvgRevenue() {
  const { from, to, prevFrom, prevTo } = currentExecKpiRange();
  const days = Math.max(1, Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1);
  const prevDays = Math.max(1, Math.round((prevTo - prevFrom) / (24 * 60 * 60 * 1000)) + 1);
  const [curRes, prevRes] = await Promise.all([
    apiGet(`/reports/revenue?${new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) })}`),
    apiGet(`/reports/revenue?${new URLSearchParams({ from: _isoDate(prevFrom), to: _isoDate(prevTo) })}`),
  ]);
  const currAvg = curRes.data.totals.collected / days;
  const prevAvg = prevRes.data.totals.collected / prevDays;
  setText('ekAvgRevenueValue', formatCurrency(Math.round(currAvg)));
  _applyCompare('ekAvgRevenueCompare', _pctChange(currAvg, prevAvg));
  setText('ekAvgRevenueFooter', `Over ${days} day${days === 1 ? '' : 's'}`);
  _lastExecKpi = _lastExecKpi || {};
  _lastExecKpi.avgRevenue = { currAvg, prevAvg };
}

// 5. Collection Rate — /reports/revenue totals.collectionRate
// (server already computes Paid / Total invoiced for the window).
// Bar + value color: green >90%, orange 70-90%, red <70%.
async function loadExecKpiCollection() {
  const { from, to } = currentExecKpiRange();
  const res = await apiGet(`/reports/revenue?${new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) })}`);
  const rate = res.data.totals.collectionRate || 0;
  setText('ekCollectionValue', `${rate}%`);
  const bar = document.getElementById('ekCollectionBar');
  const tier = rate > 90 ? 'good' : rate >= 70 ? 'warn' : 'bad';
  if (bar) {
    bar.style.width = `${Math.min(100, rate)}%`;
    bar.className = `exec-kpi-bar-fill ${tier}`;
  }
  setText('ekCollectionFooter', `${formatCurrency(res.data.totals.collected)} of ${formatCurrency(res.data.totals.invoiced)} invoiced`);
  _lastExecKpi = _lastExecKpi || {};
  _lastExecKpi.collection = { rate };
}

// 6. Outstanding Amount — /reports/outstanding totalOutstanding.
// This endpoint has no from/to (it's always "every open invoice
// right now"), so unlike the other five cards this is a live
// snapshot rather than a range-scoped figure — the footer says so
// explicitly instead of implying a comparison that isn't real.
async function loadExecKpiOutstanding() {
  const res = await apiGet('/reports/outstanding');
  const amount = res.data.totalOutstanding || 0;
  const count = res.data.openInvoiceCount || 0;
  setText('ekOutstandingValue', formatCurrency(amount));
  const el = document.getElementById('ekOutstandingCompare');
  if (el) {
    el.className = 'exec-kpi-compare' + (count > 0 ? ' down' : ' neutral');
    el.innerHTML = count > 0
      ? `<span class="material-symbols-outlined">receipt_long</span> ${count} unpaid invoice${count === 1 ? '' : 's'}`
      : `<span class="material-symbols-outlined">check_circle</span> All invoices settled`;
  }
  setText('ekOutstandingFooter', 'Unpaid invoices, as of today');
  _lastExecKpi = _lastExecKpi || {};
  _lastExecKpi.outstanding = { amount, count };
}

// Re-fetch every card (no page reload) whenever the range changes.
function initExecKpiDateControls() {
  const sel = document.getElementById('reportsDateRangeSelect');
  const fromEl = document.getElementById('reportsCustomFrom');
  const toEl = document.getElementById('reportsCustomTo');
  if (!sel) return;

  const syncCustomVisibility = () => {
    const isCustom = sel.value === 'Custom Range';
    if (fromEl) fromEl.style.display = isCustom ? '' : 'none';
    if (toEl) toEl.style.display = isCustom ? '' : 'none';
  };
  syncCustomVisibility();

  sel.addEventListener('change', () => {
    syncCustomVisibility();
    if (sel.value !== 'Custom Range') loadExecutiveKpis();
  });
  fromEl?.addEventListener('change', () => { if (sel.value === 'Custom Range' && fromEl.value && toEl.value) loadExecutiveKpis(); });
  toEl?.addEventListener('change', () => { if (sel.value === 'Custom Range' && fromEl.value && toEl.value) loadExecutiveKpis(); });
}


document.addEventListener('DOMContentLoaded', () => {
  initLayout('reports');
  // Phase 13.2 — nothing below runs if the user lacks reports.view.
  window._appPageGuardReady.then(allowed => {
    if (!allowed) return;
    // Executive KPI cards (Phase R1) run for anyone with reports.view —
    // every endpoint they call (revenue/appointments/patients/growth/
    // outstanding) is view-gated on the server, unlike the Doctor
    // Performance table below which needs reports.manage specifically
    // (see server.js buildDefaultMatrix — getDoctorPerformanceReport is
    // "manage"-gated; the KPI-backing endpoints are all "view").
    initExecKpiDateControls();
    loadExecutiveKpis();

    if (can('reports', 'manage')) {
      loadOverviewKpis();
      loadPerformanceTable();
    } else {
      document.getElementById('performanceTableBody')?.closest('.card')?.remove();
    }

    // Core Analytics (Phase R2) — Revenue Trend, Appointment Status,
    // Top Departments. Share the page's date-range select; each widget
    // loads/fails independently and re-fetches when the range changes.
    initCoreAnalyticsControls();
    loadCoreRevenueTrend();
    loadCoreApptStatus();
    loadCoreTopDepartments();

    loadRevenueAnalytics();
    loadPatientGrowth();
    loadInsights();
    applyReportsPagePermissions();
    if (can('reports', 'export')) initReportsExport();
  });
});

/* ============================================================
   PAGE-LEVEL BUTTON PERMISSIONS (Phase 13.2)
   ============================================================ */
function applyReportsPagePermissions() {
  if (!can('reports', 'export')) {
    document.getElementById('reportsExportPdfBtn')?.remove();
    document.getElementById('reportsPerfExportBtn')?.remove();
  }
  // "Share Report" has no dedicated permission action in the matrix —
  // treat it as an export-adjacent capability, gated the same way.
  if (!can('reports', 'export')) {
    document.querySelectorAll('.page-header-actions .btn-primary').forEach(btn => {
      if (btn.textContent.includes('Share Report')) btn.remove();
    });
  }
}

/* ---------- KPI strip ---------- */

// NOTE: the Executive KPI Cards (Phase R1, see loadExecutiveKpis
// above) replaced the old 3-card .kpi-grid that used to read
// kpiRevenueYtd/kpiPatientsYtd/kpiApptsYtd from this response — those
// elements no longer exist. This call is kept only for the two chart
// badges (fixed "this month vs last month", independent of the
// Executive KPI date-range selector) and for _lastOverview, which the
// PDF export's Summary section still reads.
async function loadOverviewKpis() {
  try {
    const res = await apiGet('/reports/overview');
    const o = res.data;
    _lastOverview = o;
    setText('revenueChartBadge', fmtTrend(o.revenue.changePct));
    setText('patientChartBadge', fmtTrend(o.newPatients.changePct));
  } catch (err) {
    console.error('Failed to load overview KPIs:', err);
  }
}

/* ---------- Revenue Analytics chart (12mo) ---------- */

let _charts = {};
function destroyChart(key) { if (_charts[key]) { _charts[key].destroy(); delete _charts[key]; } }

async function loadRevenueAnalytics() {
  const ctx = document.getElementById('revenueAnalyticsChart')?.getContext('2d');
  if (!ctx) return;
  try {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 11, 1);
    const params = new URLSearchParams({ period: 'monthly', from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    const res = await apiGet(`/reports/revenue?${params}`);
    const trend = res.data.trend || [];
    _lastRevenueTrend = trend;

    const g = ctx.createLinearGradient(0, 0, 0, 220);
    g.addColorStop(0, 'rgba(46,189,133,0.18)');
    g.addColorStop(1, 'rgba(46,189,133,0)');
    destroyChart('revenue');
    _charts.revenue = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map(t => t.bucket),
        datasets: [{
          label: 'Revenue ($)', data: trend.map(t => t.collected),
          borderColor: '#2EBD85', borderWidth: 2.5, backgroundColor: g, fill: true,
          tension: 0.45, pointBackgroundColor: '#2EBD85', pointBorderColor: '#fff',
          pointBorderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
        }],
      },
      options: chartOptions(true),
    });
  } catch (err) {
    console.error('Failed to load revenue analytics:', err);
  }
}

/* ---------- Patient Growth chart (12mo, new vs returning) ---------- */

async function loadPatientGrowth() {
  const ctx = document.getElementById('patientGrowthChart')?.getContext('2d');
  if (!ctx) return;
  try {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 11, 1);
    const params = new URLSearchParams({ period: 'monthly', from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    const res = await apiGet(`/reports/patients/growth?${params}`);
    const trend = res.data.trend || [];
    _lastPatientGrowth = trend;

    destroyChart('patientGrowth');
    _charts.patientGrowth = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: trend.map(t => t.bucket),
        datasets: [{ label: 'New Patients', data: trend.map(t => t.newPatients), backgroundColor: 'rgba(27,77,62,0.8)', borderRadius: 5, borderSkipped: false }],
      },
      options: {
        ...chartOptions(false),
        plugins: { ...chartOptions(false).plugins, legend: { display: true, labels: { font: { family: 'Inter', size: 11 }, color: '#52647a', boxWidth: 10, padding: 12 } } },
      },
    });
  } catch (err) {
    console.error('Failed to load patient growth:', err);
  }
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function chartOptions(isCurrency = false, area = false) {
  return {
    responsive: true,
    plugins: { legend: { display: false }, tooltip: tooltipOpts(isCurrency) },
    scales: {
      x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974' } },
      y: { grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974', callback: v => isCurrency ? formatCurrency(v >= 1000 ? v / 1000 : v) + (v >= 1000 ? 'K' : '') : v } },
    },
  };
}
function tooltipOpts(isCurrency = false) {
  return {
    backgroundColor: 'rgba(255,255,255,0.95)', titleColor: '#121c2c', bodyColor: '#52647a',
    borderColor: 'rgba(46,189,133,0.3)', borderWidth: 1, cornerRadius: 10, padding: 12,
    callbacks: { label: c => { const v = typeof c.parsed === 'object' ? c.parsed.y : c.parsed; return isCurrency ? formatCurrency(v) : String(v); } },
  };
}

/* ============================================================
   CORE ANALYTICS WIDGETS (Phase R2)
   Revenue Trend | Appointment Status | Top Departments.
   All three share the page date-range select (reportsDateRangeSelect
   / currentExecKpiRange()) so switching "Last 7 Days" etc. re-scopes
   all of Reports consistently. Revenue Trend additionally has its own
   Day/Week/Month toggle controlling aggregation granularity within
   that range — independent of the other two widgets, and independent
   of each other's load/error state per the "one widget's failure
   shouldn't affect the others" requirement.
   ============================================================ */

let _coreRevenuePeriod = 'weekly';
let _lastCoreRevenueTrend = null;
let _lastCoreApptStatus = null;
let _lastCoreDeptList = null;

function _showWidgetState(prefix, state) {
  // state: 'loading' | 'data' | 'empty' | 'error'
  const skel = document.getElementById(`core${prefix}Skel`);
  const empty = document.getElementById(`core${prefix}Empty`);
  const error = document.getElementById(`core${prefix}Error`);
  const dataEls = {
    Revenue: [document.getElementById('coreRevenueChart')],
    Appt: [document.getElementById('coreApptDonutWrap')],
    Dept: [document.getElementById('coreDeptList')],
  }[prefix] || [];

  if (skel) skel.style.display = state === 'loading' ? 'flex' : 'none';
  if (empty) empty.style.display = state === 'empty' ? 'flex' : 'none';
  if (error) error.style.display = state === 'error' ? 'flex' : 'none';
  dataEls.forEach(el => { if (el) el.style.display = state === 'data' ? '' : 'none'; });
}

function initCoreAnalyticsControls() {
  const toggle = document.getElementById('revenueTrendViewToggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.cv-btn');
      if (!btn) return;
      toggle.querySelectorAll('.cv-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _coreRevenuePeriod = btn.dataset.view;
      loadCoreRevenueTrend();
    });
  }

  // Re-fetch all three core widgets whenever the page date range changes.
  const sel = document.getElementById('reportsDateRangeSelect');
  const fromEl = document.getElementById('reportsCustomFrom');
  const toEl = document.getElementById('reportsCustomTo');
  const refetchAll = () => {
    loadCoreRevenueTrend();
    loadCoreApptStatus();
    loadCoreTopDepartments();
  };
  sel?.addEventListener('change', () => { if (sel.value !== 'Custom Range') refetchAll(); });
  fromEl?.addEventListener('change', () => { if (sel?.value === 'Custom Range' && fromEl.value && toEl.value) refetchAll(); });
  toEl?.addEventListener('change', () => { if (sel?.value === 'Custom Range' && fromEl.value && toEl.value) refetchAll(); });
}

/* ---------- 1. Revenue Trend ---------- */

async function loadCoreRevenueTrend() {
  _showWidgetState('Revenue', 'loading');
  const ctx = document.getElementById('coreRevenueChart')?.getContext('2d');
  if (!ctx) return;
  try {
    const { from, to } = currentExecKpiRange();
    const params = new URLSearchParams({ period: _coreRevenuePeriod, from: _isoDate(from), to: _isoDate(to) });

    // Merge revenue trend with appointment counts per the same bucket
    // so the tooltip can show Date / Revenue / Invoices / Appointments
    // together — /reports/revenue alone has no appointment counts.
    const [revRes, apptRes] = await Promise.all([
      apiGet(`/reports/revenue?${params}`),
      apiGet(`/reports/appointments?${params}`),
    ]);
    const trend = revRes.data.trend || [];
    _lastCoreRevenueTrend = trend;
    _lastRevenueTrend = _lastRevenueTrend || trend; // keep PDF export fed even if 12mo chart hasn't loaded yet

    if (!trend.length || !trend.some(t => t.collected > 0)) {
      _showWidgetState('Revenue', 'empty');
      return;
    }

    const apptByBucket = {};
    (apptRes.data.trend || []).forEach(t => { apptByBucket[t.bucket] = t.count; });

    const g = ctx.createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, 'rgba(46,189,133,0.18)');
    g.addColorStop(1, 'rgba(46,189,133,0)');
    destroyChart('coreRevenue');
    _charts.coreRevenue = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map(t => _fmtBucketLabel(t.bucket, _coreRevenuePeriod)),
        datasets: [{
          label: 'Revenue', data: trend.map(t => t.collected),
          borderColor: '#2EBD85', borderWidth: 2.5, backgroundColor: g, fill: true,
          tension: 0.4, pointBackgroundColor: '#2EBD85', pointBorderColor: '#fff',
          pointBorderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(255,255,255,0.97)', titleColor: '#121c2c', bodyColor: '#52647a',
            borderColor: 'rgba(46,189,133,0.3)', borderWidth: 1, cornerRadius: 10, padding: 12,
            callbacks: {
              title: (items) => trend[items[0].dataIndex]?.bucket || '',
              label: (item) => {
                const row = trend[item.dataIndex];
                return [
                  `Revenue: ${formatCurrency(row.collected)}`,
                  `Invoices: ${row.invoiceCount}`,
                  `Appointments: ${apptByBucket[row.bucket] || 0}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974', autoSkip: true, maxRotation: 0 } },
          y: { grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974', callback: v => formatCurrency(v >= 1000 ? v / 1000 : v) + (v >= 1000 ? 'K' : '') } },
        },
      },
    });
    _showWidgetState('Revenue', 'data');
  } catch (err) {
    console.error('Failed to load revenue trend:', err);
    _showWidgetState('Revenue', 'error');
  }
}

// Turns a raw bucket key ("2026-06-19", "2026-W25", "2026-06") into a
// short axis label appropriate to the active granularity.
function _fmtBucketLabel(bucket, period) {
  if (period === 'daily') {
    const d = new Date(bucket + 'T00:00:00');
    return isNaN(d) ? bucket : d.toLocaleDateString('default', { month: 'short', day: 'numeric' });
  }
  if (period === 'weekly') {
    return bucket.replace(/^(\d{4})-W(\d{2})$/, 'Wk $2');
  }
  if (period === 'monthly') {
    const [y, m] = bucket.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return isNaN(d) ? bucket : d.toLocaleDateString('default', { month: 'short', year: '2-digit' });
  }
  return bucket;
}

/* ---------- 2. Appointment Status ---------- */

async function loadCoreApptStatus() {
  _showWidgetState('Appt', 'loading');
  const ctx = document.getElementById('coreApptStatusChart')?.getContext('2d');
  if (!ctx) return;
  try {
    const { from, to } = currentExecKpiRange();
    const params = new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) });
    const res = await apiGet(`/reports/appointments?${params}`);
    const byStatus = res.data.byStatus || {};
    _lastCoreApptStatus = byStatus;
    _lastApptStatus = _lastApptStatus || byStatus; // keep PDF export fed

    // Spec statuses: Completed, Scheduled, Waiting, Cancelled, No Show.
    // "confirmed" (a real backend status not named in the spec) is
    // folded into Scheduled so every appointment is still accounted
    // for without adding an unlisted slice.
    const scheduled = (byStatus.scheduled || 0) + (byStatus.confirmed || 0);
    const labels = ['Completed', 'Scheduled', 'Waiting', 'Cancelled', 'No Show'];
    const values = [byStatus.completed || 0, scheduled, byStatus.waiting || 0, byStatus.cancelled || 0, byStatus.no_show || 0];
    const colors = ['#2EBD85', '#0061a4', '#e07b00', '#ba1a1a', '#707974'];
    const total = values.reduce((a, b) => a + b, 0);

    if (!total) {
      _showWidgetState('Appt', 'empty');
      return;
    }

    destroyChart('coreAppt');
    _charts.coreAppt = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '72%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(255,255,255,0.97)', titleColor: '#121c2c', bodyColor: '#52647a',
            borderColor: 'rgba(46,189,133,0.3)', borderWidth: 1, cornerRadius: 10, padding: 10,
            callbacks: { label: (c) => `${c.label}: ${c.parsed} (${total ? Math.round((c.parsed / total) * 100) : 0}%)` },
          },
        },
      },
    });
    setText('coreApptTotalVal', total.toLocaleString('en-US'));
    document.getElementById('coreApptLegend').innerHTML = labels.map((l, i) => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${colors[i]}"></div>
        <span class="legend-label">${l}</span>
        <span class="legend-val">${values[i]} · ${total ? Math.round((values[i] / total) * 100) : 0}%</span>
      </div>
    `).join('');
    _showWidgetState('Appt', 'data');
  } catch (err) {
    console.error('Failed to load appointment status:', err);
    _showWidgetState('Appt', 'error');
  }
}

/* ---------- 3. Top Departments ---------- */

async function loadCoreTopDepartments() {
  _showWidgetState('Dept', 'loading');
  const list = document.getElementById('coreDeptList');
  if (!list) return;
  try {
    const { from, to } = currentExecKpiRange();
    const params = new URLSearchParams({ from: _isoDate(from), to: _isoDate(to) });
    const res = await apiGet(`/reports/revenue?${params}`);
    const byDept = (res.data.byDepartment || []).slice().sort((a, b) => b.revenue - a.revenue);
    _lastCoreDeptList = byDept;
    _lastDeptRevenue = _lastDeptRevenue || byDept; // keep PDF export fed

    if (!byDept.length) {
      _showWidgetState('Dept', 'empty');
      return;
    }

    const maxRevenue = byDept[0].revenue || 1;
    list.innerHTML = byDept.slice(0, 6).map((d, i) => {
      const pct = Math.round((d.revenue / maxRevenue) * 100);
      return `
        <div class="dept-bar-row">
          <div class="dept-bar-row-top">
            <div class="dept-bar-name">
              <span class="dn-text">${d.specialization}</span>
              ${i === 0 ? '<span class="dept-top-badge">Top</span>' : ''}
            </div>
            <div class="dept-bar-pct">${pct}%</div>
          </div>
          <div class="dept-bar-track"><div class="dept-bar-fill" style="width:${pct}%"></div></div>
          <div class="dept-bar-meta">
            <span>${formatCurrency(d.revenue)}</span>
            <span>·</span>
            <span>${d.patientCount ?? 0} patient${d.patientCount === 1 ? '' : 's'}</span>
          </div>
        </div>
      `;
    }).join('');
    _showWidgetState('Dept', 'data');
  } catch (err) {
    console.error('Failed to load top departments:', err);
    _showWidgetState('Dept', 'error');
  }
}

/* ---------- Doctor Performance table ---------- */

async function loadPerformanceTable() {
  const tbody = document.getElementById('performanceTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-muted text-sm" style="padding:16px">Loading…</td></tr>`;
  try {
    const res = await apiGet('/reports/doctors/performance');
    const doctors = res.data.doctors || [];
    _lastDoctorPerformance = doctors;
    if (!doctors.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-muted text-sm" style="padding:16px">No performance data yet</td></tr>`;
      return;
    }
    tbody.innerHTML = doctors.map(d => `
      <tr>
        <td>
          <div class="flex items-center gap-sm">
            <div class="table-avatar ${d.avatarColor || 'av-1'}">${d.initials || ''}</div>
            <div class="td-primary">${d.fullName}</div>
          </div>
        </td>
        <td><div class="td-muted">${d.specialization || ''}</div></td>
        <td><div class="td-primary">${d.patients}</div></td>
        <td><div class="td-primary">${d.appointments}</div></td>
        <td><div class="td-primary font-bold">${formatCurrency(d.revenue)}</div></td>
        <td><span class="badge-status badge-confirmed">${d.completionRate}% completed</span></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load doctor performance:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-muted text-sm" style="padding:16px">Could not load performance data</td></tr>`;
  }
}

/* ---------- Business Insights ---------- */

async function loadInsights() {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const params = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) });
    const [apptRes, revRes, growthRes] = await Promise.all([
      apiGet(`/reports/appointments?${params}`),
      apiGet(`/reports/revenue?${params}`),
      apiGet(`/reports/patients/growth?${params}`),
    ]);

    // Top department (real, from revenue-by-department)
    const topDept = (revRes.data.byDepartment || [])[0];
    if (topDept) {
      setText('insightTopDept', topDept.specialization);
      setText('insightTopDeptDesc', `${topDept.specialization} generated the most revenue this month (${formatCurrency(topDept.revenue)}).`);
    } else {
      setText('insightTopDept', '—');
      setText('insightTopDeptDesc', 'No revenue recorded yet this month.');
    }

    // No-show rate (real, from appointments report)
    const noShowRate = apptRes.data.totals.noShowRate;
    setText('insightNoShow', noShowRate + '%');
    setText('insightNoShowDesc', `${apptRes.data.totals.noShow} of ${apptRes.data.totals.total} appointments this month were no-shows.`);

    // Patient retention (real, from patients/growth visitMix)
    const mix = growthRes.data.visitMix || {};
    const totalPatients = (mix.new?.patients || 0) + (mix.returning?.patients || 0);
    const retentionPct = totalPatients ? Math.round((mix.returning.patients / totalPatients) * 100) : 0;
    setText('insightRetention', retentionPct + '%');
    setText('insightRetentionDesc', `${mix.returning?.patients || 0} of ${totalPatients} patients seen this month were returning visits.`);

    _lastInsights = {
      topDept: topDept ? { name: topDept.specialization, revenue: topDept.revenue } : null,
      noShowRate,
      noShow: apptRes.data.totals.noShow,
      totalAppts: apptRes.data.totals.total,
      retentionPct,
      returningPatients: mix.returning?.patients || 0,
      totalPatients,
    };
  } catch (err) {
    console.error('Failed to load insights:', err);
  }
}
/* ---------- Export (Phase 12.2) ----------
   Two export entry points on this page:
     • Header "Export PDF" — full report (KPIs, all charts as tables,
       doctor performance, insights), respecting the date-range select.
     • Table "Export" — just the Doctor Performance table.
   Both reuse the cached _last* snapshots so the export matches what's
   currently on screen rather than re-querying with a new date range. */
function initReportsExport() {
  initExportButton({
    buttonSelector: '#reportsExportPdfBtn',
    title: 'Reports & Analytics',
    getFilenameBase: () => {
      const { from, to } = currentReportsDateRange();
      return `Reports_${from}_to_${to}`;
    },
    supportsScope: false,
    buildRows: async () => {
      const rows = [];

      if (_lastExecKpi) {
        const k = _lastExecKpi;
        rows.push(['Executive Summary (Selected Range)', '', '']);
        if (k.revenue) rows.push(['Total Revenue', formatCurrency(k.revenue.curr), fmtTrend(_pctChange(k.revenue.curr, k.revenue.prev))]);
        if (k.appointments) rows.push(['Total Appointments', k.appointments.curr, fmtTrend(_pctChange(k.appointments.curr, k.appointments.prev))]);
        if (k.patients) rows.push(['Active Patients', k.patients.active, `+${k.patients.newInRange} new`]);
        if (k.avgRevenue) rows.push(['Avg Daily Revenue', formatCurrency(Math.round(k.avgRevenue.currAvg)), fmtTrend(_pctChange(k.avgRevenue.currAvg, k.avgRevenue.prevAvg))]);
        if (k.collection) rows.push(['Collection Rate', `${k.collection.rate}%`, '']);
        if (k.outstanding) rows.push(['Outstanding Amount', formatCurrency(k.outstanding.amount), `${k.outstanding.count} unpaid invoices`]);
        rows.push(['', '', '']);
      }

      if (_lastOverview) {
        const o = _lastOverview;
        rows.push(['Summary (This Month vs Last Month)', '', '']);
        rows.push(['Revenue (This Month)', formatCurrency(o.revenue.thisMonth), fmtTrend(o.revenue.changePct)]);
        rows.push(['Active Patients', o.activePatients, fmtTrend(o.newPatients.changePct)]);
        rows.push(['Appointments (This Month)', o.appointments.thisMonth, fmtTrend(o.appointments.changePct)]);
        rows.push(['', '', '']);
      }

      if (_lastRevenueTrend?.length) {
        rows.push(['Revenue Analytics (Monthly)', '', '']);
        rows.push(['Month', 'Revenue', '']);
        _lastRevenueTrend.forEach(t => rows.push([t.bucket, t.collected, '']));
        rows.push(['', '', '']);
      }

      if (_lastPatientGrowth?.length) {
        rows.push(['Patient Growth (Monthly)', '', '']);
        rows.push(['Month', 'New Patients', '']);
        _lastPatientGrowth.forEach(t => rows.push([t.bucket, t.newPatients, '']));
        rows.push(['', '', '']);
      }

      if (_lastApptStatus) {
        rows.push(['Appointment Analytics (This Month)', '', '']);
        rows.push(['Status', 'Count', '']);
        Object.entries(_lastApptStatus).forEach(([status, count]) => rows.push([capitalize(status), count, '']));
        rows.push(['', '', '']);
      }

      if (_lastDeptRevenue?.length) {
        rows.push(['Department Revenue', '', '']);
        rows.push(['Department', 'Revenue', '']);
        _lastDeptRevenue.forEach(d => rows.push([d.specialization, d.revenue, '']));
        rows.push(['', '', '']);
      }

      if (_lastDoctorPerformance?.length) {
        rows.push(['Doctor Performance', '', '']);
        rows.push(['Doctor', 'Specialization', 'Patients / Appointments / Revenue / Completion']);
        _lastDoctorPerformance.forEach(d => rows.push([
          d.fullName,
          d.specialization || '',
          `${d.patients} patients · ${d.appointments} appts · ${formatCurrency(d.revenue)} · ${d.completionRate}% completed`,
        ]));
        rows.push(['', '', '']);
      }

      if (_lastInsights) {
        rows.push(['Business Insights', '', '']);
        if (_lastInsights.topDept) rows.push(['Top Department', _lastInsights.topDept.name, formatCurrency(_lastInsights.topDept.revenue)]);
        rows.push(['No-Show Rate', `${_lastInsights.noShowRate}%`, `${_lastInsights.noShow} of ${_lastInsights.totalAppts}`]);
        rows.push(['Patient Retention', `${_lastInsights.retentionPct}%`, `${_lastInsights.returningPatients} of ${_lastInsights.totalPatients}`]);
      }

      const headers = ['Metric', 'Value', 'Detail'];
      return { headers, rows, sheetName: 'Reports' };
    },
  });

  initExportButton({
    buttonSelector: '#reportsPerfExportBtn',
    title: 'Doctor Performance Report',
    getFilenameBase: () => `Doctor_Performance_${exportFmtDateStamp()}`,
    supportsScope: false,
    buildRows: async () => {
      const headers = ['Doctor', 'Specialization', 'Patients Seen', 'Appointments', 'Revenue', 'Completion Rate'];
      const rows = (_lastDoctorPerformance || []).map(d => [
        d.fullName,
        d.specialization || '',
        d.patients,
        d.appointments,
        d.revenue,
        `${d.completionRate}%`,
      ]);
      return { headers, rows, sheetName: 'Doctor Performance' };
    },
  });
}