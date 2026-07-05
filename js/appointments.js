/* APPOINTMENTS JS — Phase: Hardcoded Data Removal Audit
   Data source: GET /api/appointments (list + filters), GET /api/appointments/:id
   No mock arrays. MongoDB via api.js is the single source of truth. */

let APPOINTMENTS = [];        // current page, from the API
let activeStatusFilter = 'all';
let filterDebounce = null;

const STATUS_MAP = {
  scheduled: 'badge-scheduled',
  confirmed: 'badge-confirmed',
  waiting: 'badge-waiting',
  completed: 'badge-completed',
  cancelled: 'badge-cancelled',
  no_show: 'badge-cancelled',
};

// If we arrived from the Dashboard's Doctor Performance widget
// (Phase D6, "View Today's Appointments") the doctor's name and
// today's date are on the URL as ?filterDoctor=&filterDate=. Applied
// after loadFilterDropdowns() resolves (so the doctor <option> list
// actually exists to select from) — same doctorFilter/dateFilter
// controls a person could set by hand, just pre-filled, so no new
// filtering mechanism is introduced.
document.addEventListener('DOMContentLoaded', () => {
  initLayout('appointments');
  // Phase 13.2 — nothing below runs if the user lacks appointments.view.
  window._appPageGuardReady.then(allowed => {
    if (!allowed) return;
    const today = new Date().toISOString().slice(0, 10);
    const dateEl = document.getElementById('dateFilter');
    if (dateEl) dateEl.value = today;
    const lbl = document.getElementById('todaySummaryDate');
    if (lbl) lbl.textContent = new Date().toLocaleDateString('default', { month: 'long', day: 'numeric' });

    loadTodaySummary();
    loadFilterDropdowns().then(() => {
      const params = new URLSearchParams(window.location.search);
      const filterDoctor = params.get('filterDoctor');
      const filterDate = params.get('filterDate');
      if (filterDate) { const de = document.getElementById('dateFilter'); if (de) de.value = filterDate; }
      if (filterDoctor) { const ds = document.getElementById('doctorFilter'); if (ds) ds.value = filterDoctor; }
      if (filterDoctor || filterDate) window.history.replaceState({}, '', window.location.pathname);
      loadAppointments();
    });
    initFilters();
    initStatusPills();
    consumePrefillPatient();
    consumePrefillDoctor();

    // Deep link from the global header search (global.js: goToAppointment)
    // — opens this appointment's detail modal directly on arrival.
    const openId = new URLSearchParams(window.location.search).get('openAppt');
    if (openId) showDetail(openId);

    initAppointmentsExport();
    applyAppointmentsPagePermissions();
  });
});

/* ============================================================
   PAGE-LEVEL BUTTON PERMISSIONS (Phase 13.2)
   ============================================================ */
function applyAppointmentsPagePermissions() {
  if (!can('appointments', 'create')) {
    document.querySelector('[onclick="openModal(\'addApptModal\')"]')?.remove();
  }
  if (!can('appointments', 'export')) {
    // initAppointmentsExport() (called just before this function) is
    // what actually injects #apptExportBtn into the DOM — safe to
    // remove by id now that it's had a chance to run.
    document.getElementById('apptExportBtn')?.remove();
  }
}

/* ---------- Export (Phase 12.2) ----------
   Respects search, doctor/department, status pill, and date filter
   exactly as the table does (see currentFilters()/loadAppointments()).
   doctor/dept are name-based client-side filters here (same limitation
   as the table itself — the API filters by id, not display name), so
   "Export All" re-applies them client-side after paging through every
   matching appointment. */
function initAppointmentsExport() {
  initExportButton({
    buttonSelector: '#apptExportBtn',
    title: 'Appointments',
    getFilenameBase: () => `Appointments_${exportFmtDateStamp()}`,
    supportsScope: true,
    hasCurrentPageData: () => APPOINTMENTS.length > 0,
    buildRows: async (scope) => {
      const { params, doctor, dept } = currentFilters();
      let data;
      if (scope === 'page') {
        data = APPOINTMENTS;
      } else {
        const qs = new URLSearchParams(params).toString();
        data = await exportFetchAllPages(`/appointments${qs ? '?' + qs : ''}`);
        if (doctor) data = data.filter(a => a.doctorId?.fullName === doctor);
        if (dept) data = data.filter(a => a.doctorId?.specialization === dept);
      }
      const headers = ['Appointment ID', 'Patient', 'Doctor', 'Department', 'Date', 'Time', 'Status', 'Type'];
      const rows = data.map(a => [
        a._id || '',
        a.patientId?.fullName || 'Unknown patient',
        a.doctorId?.fullName || 'Unknown doctor',
        a.doctorId?.specialization || '',
        exportFmtDate(a.appointmentDate),
        a.startTime || '',
        (a.status || '').replace(/_/g, ' '),
        a.type || '',
      ]);
      return { headers, rows, sheetName: 'Appointments' };
    },
  });
}

// If we were sent here via patients.js's "Book Appointment" action
// (bookAppointmentFor), a patient was stashed in sessionStorage and
// ?bookFor=<id> is on the URL. Pop the New Appointment modal open
// with that patient already selected instead of leaving it blank.
function consumePrefillPatient() {
  const params = new URLSearchParams(window.location.search);
  const bookFor = params.get('bookFor');
  if (!bookFor) return;

  const raw = sessionStorage.getItem('medicore_prefill_patient');
  sessionStorage.removeItem('medicore_prefill_patient');
  let prefill = null;
  try { prefill = raw ? JSON.parse(raw) : null; } catch (_) { prefill = null; }

  resetNewApptForm();
  loadDoctorsForNewAppt();
  if (prefill && prefill.id === bookFor) {
    selectNewApptPatient(prefill.id, prefill.name || '');
  } else {
    document.getElementById('newApptPatientId').value = bookFor;
  }
  openModal('addApptModal');

  // Clean the query string so a page refresh doesn't reopen the modal.
  window.history.replaceState({}, '', window.location.pathname);
}

// If we were sent here via doctors.js's "Schedule" action
// (scheduleWithDoctor), a doctor was stashed in sessionStorage and
// ?scheduleWith=<id> is on the URL. Pop the New Appointment modal
// open with that doctor already selected.
function consumePrefillDoctor() {
  const params = new URLSearchParams(window.location.search);
  const scheduleWith = params.get('scheduleWith');
  if (!scheduleWith) return;

  const raw = sessionStorage.getItem('medicore_prefill_doctor');
  sessionStorage.removeItem('medicore_prefill_doctor');
  let prefill = null;
  try { prefill = raw ? JSON.parse(raw) : null; } catch (_) { prefill = null; }

  resetNewApptForm();
  loadDoctorsForNewAppt().then(() => {
    const select = document.getElementById('newApptDoctorId');
    if (select) select.value = (prefill && prefill.id === scheduleWith) ? prefill.id : scheduleWith;
  });
  openModal('addApptModal');

  window.history.replaceState({}, '', window.location.pathname);
}

// Populates the "All Doctors" filter dropdown from GET /api/doctors and
// the "All Departments" filter dropdown from GET /api/departments
// (Phase 12.5 — Department Management System is the single source of
// truth for departments; no longer derived from doctors' specialization
// strings). If a clinic has no departments yet, the dropdown simply
// shows only "All Departments" — no hardcoded fallback list.
async function loadFilterDropdowns() {
  const doctorSel = document.getElementById('doctorFilter');
  const deptSel = document.getElementById('deptFilter');
  if (!doctorSel && !deptSel) return;
  try {
    const [doctorsRes, deptsRes] = await Promise.all([
      doctorSel ? apiGet('/doctors?limit=100') : Promise.resolve({ data: [] }),
      deptSel ? apiGet('/departments?isActive=true&limit=100').catch(err => { console.error('Failed to load departments:', err); return { data: [] }; }) : Promise.resolve({ data: [] }),
    ]);

    if (doctorSel) {
      const currentVal = doctorSel.value;
      const doctors = doctorsRes.data || [];
      doctorSel.innerHTML = '<option value="">All Doctors</option>' +
        doctors.map(d => `<option>${d.fullName}</option>`).join('');
      doctorSel.value = currentVal;
    }

    if (deptSel) {
      const currentVal = deptSel.value;
      const depts = deptsRes.data || [];
      deptSel.innerHTML = '<option value="">All Departments</option>' +
        depts.map(dep => `<option>${dep.name}</option>`).join('');
      deptSel.value = currentVal;
    }
  } catch (err) {
    console.error('Failed to load filter dropdowns:', err);
  }
}

function currentFilters() {
  const search = document.getElementById('apptSearch')?.value || '';
  const doctor = document.getElementById('doctorFilter')?.value || '';
  const dept = document.getElementById('deptFilter')?.value || '';
  const date = document.getElementById('dateFilter')?.value || '';
  const params = {};
  if (search) params.search = search;
  if (date) params.date = date;
  if (activeStatusFilter !== 'all') params.status = activeStatusFilter;
  // doctor/dept filters are name-based in the UI but the API filters by
  // doctorId/specialization — left as client-side post-filter below since
  // the dropdowns here only have display names, not ids.
  return { params, doctor, dept };
}

async function loadAppointments() {
  const tbody = document.getElementById('apptTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">Loading appointments…</td></tr>`;
  try {
    const { params, doctor, dept } = currentFilters();
    const query = new URLSearchParams(params).toString();
    const res = await apiGet(`/appointments${query ? '?' + query : ''}`);
    let data = res.data || [];
    if (doctor) data = data.filter(a => a.doctorId?.fullName === doctor);
    if (dept) data = data.filter(a => a.doctorId?.specialization === dept);
    APPOINTMENTS = data;
    renderTable(APPOINTMENTS);
    renderUpcoming(APPOINTMENTS);
    renderApptPagination(res.pagination);
  } catch (err) {
    console.error('Failed to load appointments:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">Could not load appointments</td></tr>`;
    showToast('Could not load appointments', 'error');
  }
}

function renderApptPagination(pagination) {
  const el = document.querySelector('.pagination span');
  if (el && pagination) {
    const start = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.page * pagination.limit, pagination.total);
    el.textContent = `Showing ${start}–${end} of ${pagination.total.toLocaleString('en-US')} appointments`;
  }
}

// Today's Summary card + status-pill counts: derived from a same-day
// fetch via GET /api/appointments?date=today rather than a dedicated
// stats endpoint (none exists for this view).
async function loadTodaySummary() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await apiGet(`/appointments?date=${today}&limit=200`);
    const todays = res.data || [];
    const total = todays.length;
    const done = todays.filter(a => a.status === 'completed').length;
    const waiting = todays.filter(a => a.status === 'waiting').length;
    const missed = todays.filter(a => a.status === 'cancelled' || a.status === 'no_show').length;

    setStat('tsTotal', total);
    setStat('tsDone', done);
    setStat('tsWaiting', waiting);
    setStat('tsMissed', missed);

    const counts = { all: res.pagination?.total ?? total };
    ['scheduled', 'confirmed', 'waiting', 'completed', 'cancelled'].forEach(s => {
      counts[s] = todays.filter(a => a.status === s).length;
    });
    setPillCounts(counts);
    renderApptTypeMix(todays);
  } catch (err) {
    console.error('Failed to load today summary:', err);
  }
}

const TYPE_COLORS = { Consultation: 'var(--gradient-brand)', 'Follow-up': '#2EBD85', Telemedicine: '#57dea3', Procedure: '#0061a4', Other: '#707974' };

function renderApptTypeMix(todays) {
  const el = document.getElementById('apptTypeMix');
  if (!el) return;
  if (!todays.length) {
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">No appointments today</div>`;
    return;
  }
  const counts = {};
  todays.forEach(a => { counts[a.type || 'Other'] = (counts[a.type || 'Other'] || 0) + 1; });
  const total = todays.length;
  el.innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const pct = Math.round((count / total) * 100);
      const color = TYPE_COLORS[type] || '#707974';
      return `
        <div class="appt-type-row"><span>${type}</span><strong>${pct}%</strong></div>
        <div class="appt-type-bar"><div style="width:${pct}%;background:${color}"></div></div>
      `;
    }).join('');
}

function setStat(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setPillCounts(counts) {
  document.querySelectorAll('.status-pill').forEach(pill => {
    const key = pill.dataset.filter;
    const countEl = pill.querySelector('.pill-count');
    if (countEl && counts[key] !== undefined) countEl.textContent = counts[key];
  });
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

function renderTable(data) {
  const tbody = document.getElementById('apptTableBody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">No appointments found</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(a => {
    const patient = a.patientId || {};
    const doctor = a.doctorId || {};
    return `
    <tr>
      <td>
        <div class="flex items-center gap-sm">
          <div class="table-avatar ${doctor.avatarColor || 'av-1'}">${initialsFromName(patient.fullName)}</div>
          <div>
            <div class="td-primary">${patient.fullName || 'Unknown patient'}</div>
            <div class="td-muted">${patient.patientId || ''}</div>
          </div>
        </div>
      </td>
      <td><div class="td-primary">${doctor.fullName || ''}</div></td>
      <td><div class="td-muted">${doctor.specialization || ''}</div></td>
      <td>
        <div class="td-primary">${a.startTime || ''}</div>
        <div class="td-muted">${fmtDate(a.appointmentDate)}</div>
      </td>
      <td><div class="td-muted">${a.type || ''}</div></td>
      <td><span class="badge-status ${STATUS_MAP[a.status] || ''}">${a.status}</span></td>
      <td>
        <div class="action-btn-group">
          ${canView('appointments') ? `<button class="tbl-action-btn" title="View" onclick="showDetail('${a._id}')"><span class="material-symbols-outlined">visibility</span></button>` : ''}
          ${can('appointments', 'edit') ? `<button class="tbl-action-btn" title="Edit" onclick="openEditAppointment('${a._id}')" ${['completed', 'cancelled'].includes(a.status) ? 'disabled' : ''}><span class="material-symbols-outlined">edit</span></button>` : ''}
          ${can('appointments', 'edit') ? `<button class="tbl-action-btn" title="Cancel" onclick="cancelAppointment('${a._id}')" ${['completed', 'cancelled'].includes(a.status) ? 'disabled' : ''}><span class="material-symbols-outlined">cancel</span></button>` : ''}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

function initialsFromName(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function renderUpcoming(data) {
  const el = document.getElementById('upcomingList');
  if (!el) return;
  const upcoming = data.filter(a => a.status !== 'completed' && a.status !== 'cancelled').slice(0, 5);
  if (!upcoming.length) {
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Nothing upcoming</div>`;
    return;
  }
  el.innerHTML = upcoming.map(a => {
    const patient = a.patientId || {};
    const doctor = a.doctorId || {};
    return `
    <div class="upcoming-item">
      <div class="upcoming-item-time">${a.startTime || ''}</div>
      <div class="table-avatar ${doctor.avatarColor || 'av-1'}" style="width:28px;height:28px;font-size:10px">${initialsFromName(patient.fullName)}</div>
      <div class="upcoming-item-info">
        <div class="upcoming-item-name">${patient.fullName || 'Unknown patient'}</div>
        <div class="upcoming-item-doc">${doctor.fullName || ''}</div>
      </div>
      <span class="badge-status ${STATUS_MAP[a.status] || ''}">${a.status}</span>
    </div>
  `;
  }).join('');
}

async function showDetail(id) {
  document.getElementById('apptDetailBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Loading…</div>`;
  document.getElementById('apptDetailFooterActions').innerHTML = '';
  currentDetailApptId = id;
  openModal('apptDetailModal');
  try {
    const res = await apiGet(`/appointments/${id}`);
    const a = res.data;
    const patient = a.patientId || {};
    const doctor = a.doctorId || {};
    document.getElementById('apptDetailBody').innerHTML = `
      <div class="flex items-center gap-md mb-lg">
        <div class="table-avatar ${doctor.avatarColor || 'av-1'}" style="width:56px;height:56px;font-size:20px">${initialsFromName(patient.fullName)}</div>
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--color-on-surface)">${patient.fullName || 'Unknown patient'}</div>
          <div class="text-muted">${patient.patientId || ''}</div>
          <span class="badge-status ${STATUS_MAP[a.status] || ''}" style="margin-top:6px;display:inline-flex">${a.status}</span>
        </div>
      </div>
      <div class="divider"></div>
      <div class="form-row" style="row-gap:12px">
        <div><div class="form-label">Doctor</div><div class="font-semibold">${doctor.fullName || ''}</div></div>
        <div><div class="form-label">Department</div><div class="font-semibold">${doctor.specialization || ''}</div></div>
        <div><div class="form-label">Date</div><div class="font-semibold">${fmtDate(a.appointmentDate)}</div></div>
        <div><div class="form-label">Time</div><div class="font-semibold">${a.startTime || ''}</div></div>
        <div><div class="form-label">Type</div><div class="font-semibold">${a.type || ''}</div></div>
        <div><div class="form-label">Notes</div><div class="font-semibold">${a.notes || '—'}</div></div>
      </div>
    `;
    renderDetailFooterActions(a.status);
  } catch (err) {
    console.error('Failed to load appointment:', err);
    document.getElementById('apptDetailBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Could not load appointment</div>`;
  }
}

let currentDetailApptId = null;

// Status-transition buttons, driven by the same forward-only state
// machine the server enforces (ALLOWED_TRANSITIONS in server.js).
// Mirrored client-side only to decide which buttons to show; the
// server is still the source of truth and will reject anything else.
const NEXT_STATUS_OPTIONS = {
  scheduled: [['confirmed', 'Confirm'], ['waiting', 'Check In'], ['no_show', 'No Show']],
  confirmed: [['waiting', 'Check In'], ['completed', 'Complete'], ['no_show', 'No Show']],
  waiting: [['completed', 'Complete'], ['no_show', 'No Show']],
  completed: [],
  cancelled: [],
  no_show: [['scheduled', 'Rebook']],
};

function renderDetailFooterActions(status) {
  const el = document.getElementById('apptDetailFooterActions');
  if (!el) return;
  if (!can('appointments', 'edit')) { el.innerHTML = ''; return; }
  const options = NEXT_STATUS_OPTIONS[status] || [];
  el.innerHTML = options.map(([next, label]) =>
    `<button class="btn btn-secondary btn-sm" onclick="changeAppointmentStatus('${currentDetailApptId}','${next}')">${label}</button>`
  ).join('');
  if (!['completed', 'cancelled'].includes(status)) {
    el.innerHTML += `<button class="btn btn-primary btn-sm" onclick="closeModal('apptDetailModal');openEditAppointment('${currentDetailApptId}')"><span class="material-symbols-outlined">edit</span> Edit Appointment</button>`;
  }
}

async function changeAppointmentStatus(id, status) {
  try {
    await apiPatch(`/appointments/${id}/status`, { status });
    showToast('Appointment updated');
    closeModal('apptDetailModal');
    loadAppointments();
    loadTodaySummary();
  } catch (err) {
    console.error('Failed to update status:', err);
    showToast('Could not update appointment status', 'error');
  }
}

async function cancelAppointment(id) {
  if (!confirm('Cancel this appointment? This cannot be undone.')) return;
  try {
    await apiPatch(`/appointments/${id}/status`, { status: 'cancelled' });
    showToast('Appointment cancelled');
    loadAppointments();
    loadTodaySummary();
  } catch (err) {
    console.error('Failed to cancel appointment:', err);
    showToast('Could not cancel appointment', 'error');
  }
}

function initFilters() {
  ['apptSearch', 'doctorFilter', 'deptFilter', 'dateFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      clearTimeout(filterDebounce);
      filterDebounce = setTimeout(loadAppointments, 300);
    });
  });
}

function initStatusPills() {
  document.querySelectorAll('.status-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.status-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeStatusFilter = pill.dataset.filter;
      loadAppointments();
    });
  });
}
/* ============================================================
   NEW APPOINTMENT — real booking flow
   POST /api/appointments requires real patientId/doctorId (Mongo
   ObjectIds), not display names — see server.js
   validateAppointmentFields(). Doctor list comes from GET
   /api/doctors; patient is resolved via a live search against
   GET /api/patients?search=.
   ============================================================ */

let _newApptDoctors = [];
let _patientSearchDebounce = null;
let editingApptId = null; // null = creating new, else editing existing

document.addEventListener('DOMContentLoaded', () => {
  initNewApptModal();
});

function initNewApptModal() {
  const doctorSelect = document.getElementById('newApptDoctorId');
  doctorSelect?.addEventListener('change', () => {
    const doc = _newApptDoctors.find(d => d._id === doctorSelect.value);
    const deptEl = document.getElementById('newApptDept');
    if (deptEl) deptEl.value = doc?.specialization || '';
  });

  const searchInput = document.getElementById('newApptPatientSearch');
  searchInput?.addEventListener('input', () => {
    document.getElementById('newApptPatientId').value = '';
    clearTimeout(_patientSearchDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      document.getElementById('newApptPatientResults').style.display = 'none';
      return;
    }
    _patientSearchDebounce = setTimeout(() => runPatientSearch(q), 250);
  });

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('newApptPatientResults');
    if (wrap && !e.target.closest('#newApptPatientResults') && e.target.id !== 'newApptPatientSearch') {
      wrap.style.display = 'none';
    }
  });

  // Clicks inside the dropdown (including the inline add-patient form)
  // must never reach the document-level close handler above — without
  // this, clicking "Add as new patient" replaces the dropdown's
  // innerHTML mid-click, the original click target becomes a detached
  // node, .closest() fails, and the handler above closes the dropdown
  // before the inline form ever gets a chance to render/stay open.
  document.getElementById('newApptPatientResults')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // "New Appointment" button opens for create mode, not edit mode.
  document.querySelectorAll('[onclick*="openModal(\'addApptModal\')"]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingApptId = null;
      resetNewApptForm();
      const titleEl = document.querySelector('#addApptModal .modal-title');
      if (titleEl) titleEl.textContent = 'New Appointment';
    });
  });
}

async function runPatientSearch(q) {
  const resultsEl = document.getElementById('newApptPatientResults');
  try {
    const res = await apiGet(`/patients?search=${encodeURIComponent(q)}&limit=8`);
    const patients = res.data || [];
    const addNewRow = `
      <div class="psr-item psr-add-new" onclick="openInlineNewPatient('${q.replace(/'/g, "\\'")}')">
        <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px">person_add</span>
        Add "${q}" as a new patient
      </div>
    `;
    if (!patients.length) {
      resultsEl.innerHTML = `<div class="psr-empty">No matching patients</div>` + addNewRow;
    } else {
      resultsEl.innerHTML = patients.map(p => `
        <div class="psr-item" onclick="selectNewApptPatient('${p._id}', '${(p.fullName || '').replace(/'/g, "\\'")}')">
          ${p.fullName || 'Unknown'} <span class="text-muted" style="font-size:11px">${p.patientId || ''}</span>
        </div>
      `).join('') + addNewRow;
    }
    resultsEl.style.display = 'block';
  } catch (err) {
    console.error('Patient search failed:', err);
    resultsEl.innerHTML = `<div class="psr-empty">Search failed</div>`;
    resultsEl.style.display = 'block';
  }
}

function selectNewApptPatient(id, name) {
  document.getElementById('newApptPatientId').value = id;
  document.getElementById('newApptPatientSearch').value = name;
  document.getElementById('newApptPatientResults').style.display = 'none';
}

async function loadDoctorsForNewAppt() {
  const select = document.getElementById('newApptDoctorId');
  if (!select) return;
  try {
    const res = await apiGet('/doctors?limit=100');
    _newApptDoctors = res.data || [];
    select.innerHTML = '<option value="">Select doctor…</option>' +
      _newApptDoctors.map(d => `<option value="${d._id}">${d.fullName}${d.specialization ? ' — ' + d.specialization : ''}</option>`).join('');
  } catch (err) {
    console.error('Failed to load doctors for appointment form:', err);
    select.innerHTML = '<option value="">Could not load doctors</option>';
  }
}

function resetNewApptForm() {
  document.getElementById('newApptPatientSearch').value = '';
  document.getElementById('newApptPatientId').value = '';
  document.getElementById('newApptPatientResults').style.display = 'none';
  document.getElementById('newApptDept').value = '';
  document.getElementById('newApptNotes').value = '';
  document.getElementById('newApptType').value = 'Consultation';
  document.getElementById('newApptStartTime').value = '09:00';
  document.getElementById('newApptEndTime').value = '09:30';
  hideNewApptError();
  document.getElementById('newApptSubmitBtn').innerHTML = '<span class="material-symbols-outlined">check</span> Book';
  loadDoctorsForNewAppt();
}

function showNewApptError(msg) {
  const el = document.getElementById('newApptError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideNewApptError() {
  const el = document.getElementById('newApptError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function submitNewAppointment() {
  hideNewApptError();
  const patientId = document.getElementById('newApptPatientId').value;
  const doctorId = document.getElementById('newApptDoctorId').value;
  const appointmentDate = document.getElementById('apptModalDate').value;
  const startTime = document.getElementById('newApptStartTime').value;
  const endTime = document.getElementById('newApptEndTime').value;
  const type = document.getElementById('newApptType').value;
  const notes = document.getElementById('newApptNotes').value;

  if (!patientId) return showNewApptError('Please select a patient from the search results.');
  if (!doctorId) return showNewApptError('Please select a doctor.');
  if (!appointmentDate) return showNewApptError('Please select a date.');
  if (!startTime || !endTime) return showNewApptError('Please set start and end time.');
  if (startTime >= endTime) return showNewApptError('Start time must be before end time.');

  const payload = { patientId, doctorId, appointmentDate, startTime, endTime, type, notes };

  const btn = document.getElementById('newApptSubmitBtn');
  btn.disabled = true;

  try {
    if (editingApptId) {
      // Reschedule/edit existing appointment — status is changed via
      // the separate /status endpoint, not here.
      await apiPut(`/appointments/${editingApptId}`, payload);
      showToast('Appointment updated!');
    } else {
      await apiPost('/appointments', payload);
      showToast('Appointment booked!');
    }
    closeModal('addApptModal');
    editingApptId = null;
    loadAppointments();
    loadTodaySummary();
  } catch (err) {
    console.error('Failed to save appointment:', err);
    showNewApptError(err.message || 'Could not save appointment. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}

async function openEditAppointment(id) {
  try {
    const res = await apiGet(`/appointments/${id}`);
    const a = res.data;
    if (['completed', 'cancelled'].includes(a.status)) {
      showToast(`Cannot edit an appointment that is already ${a.status}`, 'error');
      return;
    }
    editingApptId = id;
    resetNewApptForm();
    await loadDoctorsForNewAppt();

    const patient = a.patientId || {};
    const doctor = a.doctorId || {};
    document.getElementById('newApptPatientId').value = patient._id || '';
    document.getElementById('newApptPatientSearch').value = patient.fullName || '';
    document.getElementById('newApptDoctorId').value = doctor._id || '';
    document.getElementById('newApptDept').value = doctor.specialization || '';
    document.getElementById('apptModalDate').value = fmtDate(a.appointmentDate);
    document.getElementById('newApptStartTime').value = a.startTime || '09:00';
    document.getElementById('newApptEndTime').value = a.endTime || '09:30';
    document.getElementById('newApptType').value = a.type || 'Consultation';
    document.getElementById('newApptNotes').value = a.notes || '';
    document.getElementById('newApptSubmitBtn').innerHTML = '<span class="material-symbols-outlined">check</span> Save Changes';

    document.querySelector('#addApptModal .modal-title').textContent = 'Edit Appointment';
    openModal('addApptModal');
  } catch (err) {
    console.error('Failed to load appointment for edit:', err);
    showToast('Could not load appointment for editing', 'error');
  }
}
/* ============================================================
   INLINE QUICK-ADD PATIENT (from the appointment search dropdown)
   Lets the user register a brand-new patient without leaving the
   New Appointment modal. POST /api/patients (same validation as
   patients.js: fullName + phone required). On success, the new
   patient is selected immediately so booking can continue.
   ============================================================ */

function openInlineNewPatient(prefillName) {
  const resultsEl = document.getElementById('newApptPatientResults');
  resultsEl.innerHTML = `
    <div class="psr-inline-form">
      <input class="form-input" id="inlineNewPatName" placeholder="Full name" value="${prefillName.replace(/"/g, '&quot;')}" style="margin-bottom:6px">
      <input class="form-input" id="inlineNewPatPhone" placeholder="Phone number" style="margin-bottom:6px">
      <div id="inlineNewPatError" class="text-sm" style="color:var(--color-error);display:none;margin-bottom:6px"></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="document.getElementById('newApptPatientResults').style.display='none'">Cancel</button>
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="submitInlineNewPatient()">Save & Select</button>
      </div>
    </div>
  `;
  resultsEl.style.display = 'block';
  document.getElementById('inlineNewPatPhone').focus();
}

async function submitInlineNewPatient() {
  const nameEl = document.getElementById('inlineNewPatName');
  const phoneEl = document.getElementById('inlineNewPatPhone');
  const errEl = document.getElementById('inlineNewPatError');
  const fullName = nameEl.value.trim();
  const phone = phoneEl.value.trim();

  errEl.style.display = 'none';
  if (!fullName) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
  if (!phone) { errEl.textContent = 'Phone number is required.'; errEl.style.display = 'block'; return; }

  try {
    const res = await apiPost('/patients', { fullName, phone, gender: 'Other' });
    const newPatient = res.data;
    showToast('Patient registered and selected');
    selectNewApptPatient(newPatient._id, newPatient.fullName);
  } catch (err) {
    console.error('Failed to quick-add patient:', err);
    errEl.textContent = err.message || 'Could not save patient. Please check the details.';
    errEl.style.display = 'block';
  }
}