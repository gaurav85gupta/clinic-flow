/* DOCTORS JS — Phase: Hardcoded Data Removal Audit / Phase 12.5
   Data sources:
     GET /api/doctors                       — roster (cards, profile modal)
     GET /api/reports/doctors/performance    — patients seen, appointments, revenue
     GET /api/departments                    — Department dropdown (Phase 12.5)
   No mock arrays. MongoDB via api.js is the single source of truth.

   NOTE: doctorSchema (server.js) has no `rating` field, and no
   patient-feedback collection exists yet. The original mock displayed
   a star rating with no backend source — that UI is removed here
   rather than faked. See audit report: "Missing endpoints".

   Phase 12.5 — the "Specialization" free-text input on Add Doctor is
   now a "Department" dropdown sourced from GET /api/departments (only
   active departments are offered). Doctor.specialization itself is
   still stored as a plain string on the backend (no schema change);
   it just can now only be set to a value that names a real, active
   department. */

let DOCTORS = [];
let PERF_BY_DOCTOR = {};

// Phase 12.1 (Staff Identity Linking) — which doctors already have a
// login account, so the card can show "✓ Login Already Created"
// instead of letting an admin discover that only inside Add Staff.
// Sourced from GET /api/staff/available-doctors (the inverse: it
// returns doctors WITHOUT a login), so we diff against the full
// DOCTORS list rather than adding a second endpoint for this alone.
// Only fetched for users who can actually manage staff — a doctor or
// receptionist viewing this page has no `staff.view` permission and
// doesn't need this indicator anyway.
let LINKED_DOCTOR_IDS = new Set();

document.addEventListener('DOMContentLoaded', () => {
  initLayout('doctors');
  // Phase 13.2 — nothing below runs if the user lacks doctors.view.
  window._appPageGuardReady.then(allowed => {
    if (!allowed) return;
    loadDoctors();
    loadDepartmentOptions();

    // Deep link from the global header search (global.js: goToDoctor)
    // — opens this doctor's profile modal directly on arrival.
    const openId = new URLSearchParams(window.location.search).get('openDoctor');
    if (openId) showDoctor(openId);

    initDoctorsExport();
    applyDoctorsPagePermissions();
  });
});

/* ============================================================
   PAGE-LEVEL BUTTON PERMISSIONS (Phase 13.2)
   ============================================================ */
function applyDoctorsPagePermissions() {
  if (!can('doctors', 'create')) {
    document.querySelector('[onclick="openModal(\'addDoctorModal\')"]')?.remove();
  }
  if (!can('doctors', 'export')) {
    document.querySelectorAll('.page-header-actions .btn-secondary').forEach(btn => {
      if (btn.textContent.includes('Export')) btn.remove();
    });
  }
}

/* ---------- Export (Phase 12.2) ----------
   The page has no search/filter UI (see doctors.html) — DOCTORS is
   already the clinic's full roster (limit=100), so "Export All" and
   "Current Page" return the same data; only "Export All" is offered.

   GET /doctors' list projection omits `qualification` (see server.js
   listDoctors LIST_PROJECTION) — it's only returned by GET /doctors/:id.
   The export spec requires it, so we fetch each doctor's full record
   for the export rather than leave the column blank. */
function initDoctorsExport() {
  initExportButton({
    buttonSelector: '.page-header-actions .btn-secondary',
    title: 'Doctors',
    getFilenameBase: () => `Doctors_${exportFmtDateStamp()}`,
    supportsScope: false,
    buildRows: async () => {
      const base = DOCTORS.length ? DOCTORS : await exportFetchAllPages('/doctors');
      const detailed = await Promise.all(
        base.map(d => apiGet(`/doctors/${d._id}`).then(r => r.data).catch(() => d))
      );
      const headers = ['Doctor ID', 'Name', 'Department', 'Qualification', 'Phone', 'Experience', 'Availability', 'Status'];
      const rows = detailed.map(d => [
        d.doctorId || '',
        d.fullName || '',
        d.specialization || '',
        d.qualification || '',
        d.phone || '',
        d.experienceYears != null ? `${d.experienceYears} yrs` : '',
        d.isAvailable ? 'Available' : 'On Leave',
        d.isActive === false ? 'Inactive' : 'Active',
      ]);
      return { headers, rows, sheetName: 'Doctors' };
    },
  });
}

/* ---------- Department dropdown (Phase 12.5) ----------
   Populates the "Add Doctor" Department select from GET /api/departments
   — MongoDB is the only source of truth here. Only ACTIVE departments
   are offered for new doctors (inactive departments cannot be selected
   for new doctors — existing doctors already assigned to one keep it
   untouched). If the clinic has zero departments, the dropdown shows
   "No departments found" instead of any fallback list. */
async function loadDepartmentOptions() {
  const sel = document.getElementById('newDocSpecialization');
  if (!sel) return;
  try {
    const res = await apiGet('/departments?isActive=true&limit=100');
    const depts = res.data || [];
    if (!depts.length) {
      sel.innerHTML = '<option value="">No departments found</option>';
      return;
    }
    sel.innerHTML = '<option value="">Select department…</option>' +
      depts.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
  } catch (err) {
    console.error('Failed to load departments:', err);
    sel.innerHTML = '<option value="">Could not load departments</option>';
  }
}

async function loadDoctors() {
  const cardsEl = document.getElementById('doctorCards');
  const tbody = document.getElementById('doctorTableBody');
  if (cardsEl) cardsEl.innerHTML = `<div class="text-muted text-sm" style="padding:16px">Loading doctors…</div>`;
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">Loading…</td></tr>`;

  try {
    // Phase 12.1 — available-doctors is the inverse of "already
    // linked", and is a staff.create-gated endpoint. Only fetched
    // when the current user could act on it (create a staff login);
    // for anyone else LINKED_DOCTOR_IDS just stays empty and the
    // badge below never renders — no error, no dead-end permission
    // toast for a purely informational indicator.
    const canSeeStaffLinks = can('staff', 'create');
    const [doctorsRes, perfRes, availableRes] = await Promise.all([
      apiGet('/doctors?limit=100'),
      apiGet('/reports/doctors/performance').catch(err => { console.error('Performance report failed:', err); return null; }),
      canSeeStaffLinks ? apiGet('/staff/available-doctors').catch(() => null) : Promise.resolve(null),
    ]);

    DOCTORS = doctorsRes.data || [];
    PERF_BY_DOCTOR = {};
    if (perfRes?.data?.doctors) {
      perfRes.data.doctors.forEach(d => { PERF_BY_DOCTOR[d.doctorId] = d; });
    }

    if (availableRes?.data) {
      const availableIds = new Set(availableRes.data.map(d => d._id));
      LINKED_DOCTOR_IDS = new Set(DOCTORS.filter(d => !availableIds.has(d._id)).map(d => d._id));
    } else {
      LINKED_DOCTOR_IDS = new Set();
    }

    setText('doctorsHeaderSubtitle', `${doctorsRes.pagination?.total ?? DOCTORS.length} medical staff · ${DOCTORS.filter(d => d.isAvailable).length} available today`);
    renderDoctorCards(DOCTORS);
    renderDoctorTable(DOCTORS);
  } catch (err) {
    console.error('Failed to load doctors:', err);
    if (cardsEl) cardsEl.innerHTML = `<div class="text-muted text-sm" style="padding:16px">Could not load doctors</div>`;
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">Could not load doctors</td></tr>`;
    showToast('Could not load doctors', 'error');
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderDoctorCards(data) {
  const el = document.getElementById('doctorCards');
  if (!el) return;
  if (!data.length) { el.innerHTML = `<div class="text-muted text-sm" style="padding:16px">No doctors found</div>`; return; }
  el.innerHTML = data.map(d => {
    const perf = PERF_BY_DOCTOR[d._id] || {};
    return `
    <div class="doctor-card" onclick="showDoctor('${d._id}')">
      <div class="doctor-card-header">
        <div class="doctor-card-avatar ${d.avatarColor || 'av-1'}">${d.initials || ''}</div>
        <div>
          <div class="doctor-card-name">${d.fullName}</div>
          <div class="doctor-card-spec">${d.specialization || ''}</div>
        </div>
        <span class="badge-status badge-${d.isAvailable ? 'available' : 'inactive'}">${d.isAvailable ? 'Available' : 'On Leave'}</span>
      </div>
      <div class="doctor-card-body">
        ${LINKED_DOCTOR_IDS.has(d._id) ? `<div class="text-muted text-sm" style="display:flex;align-items:center;gap:4px;margin-bottom:8px;color:var(--color-success)"><span class="material-symbols-outlined" style="font-size:14px">check_circle</span> Login Already Created</div>` : ''}
        <div class="doctor-stat-row">
          <div class="doctor-stat"><div class="doctor-stat-val">${perf.patients ?? '—'}</div><div class="doctor-stat-lbl">Patients</div></div>
          <div class="doctor-stat"><div class="doctor-stat-val">${d.experienceYears != null ? d.experienceYears + 'yr' : '—'}</div><div class="doctor-stat-lbl">Experience</div></div>
          <div class="doctor-stat"><div class="doctor-stat-val">${perf.completionRate != null ? perf.completionRate + '%' : '—'}</div><div class="doctor-stat-lbl">Completion</div></div>
        </div>
        <div class="doctor-card-meta">
          <div class="doctor-meta-row"><span class="material-symbols-outlined">phone</span>${d.phone || '—'}</div>
          <div class="doctor-meta-row"><span class="material-symbols-outlined">mail</span>${d.email || '—'}</div>
        </div>
      </div>
      <div class="doctor-card-footer">
        ${canView('doctors') ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();showDoctor('${d._id}')"><span class="material-symbols-outlined">visibility</span> Profile</button>` : ''}
        ${can('appointments', 'create') ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();scheduleWithDoctor('${d._id}','${(d.fullName || '').replace(/'/g, "\\'")}')"><span class="material-symbols-outlined">event_available</span> Schedule</button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

// Navigates to Appointments with the doctor pre-selected so the
// "New Appointment" modal opens ready to book, instead of leaving
// the card's "Schedule" button as a dead no-op. Appointments page
// reads this via sessionStorage on load (see appointments.js:
// consumePrefillDoctor).
function scheduleWithDoctor(id, name) {
  if (!id) return;
  sessionStorage.setItem('medicore_prefill_doctor', JSON.stringify({ id, name: name || '' }));
  window.location.href = 'appointments.html?scheduleWith=' + encodeURIComponent(id);
}

function renderDoctorTable(data) {
  const tbody = document.getElementById('doctorTableBody');
  if (!tbody) return;
  if (!data.length) { tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">No doctors found</td></tr>`; return; }
  tbody.innerHTML = data.map(d => {
    const perf = PERF_BY_DOCTOR[d._id] || {};
    return `
    <tr>
      <td>
        <div class="flex items-center gap-sm">
          <div class="table-avatar ${d.avatarColor || 'av-1'}">${d.initials || ''}</div>
          <div><div class="td-primary">${d.fullName}</div></div>
        </div>
      </td>
      <td><div class="td-muted">${d.specialization || ''}</div></td>
      <td><div class="td-primary">${perf.patients ?? '—'}</div></td>
      <td><div class="td-primary">${perf.completionRate != null ? perf.completionRate + '%' : '—'}</div></td>
      <td><div class="td-primary">${can('billing', 'view') ? (perf.revenue != null ? '$' + perf.revenue.toLocaleString('en-US') : '—') : '—'}</div></td>
      <td><span class="badge-status badge-${d.isAvailable ? 'available' : 'inactive'}">${d.isAvailable ? 'Available' : 'On Leave'}</span></td>
      <td>
        <div class="action-btn-group">
          ${canView('doctors') ? `<button class="tbl-action-btn" onclick="showDoctor('${d._id}')"><span class="material-symbols-outlined">visibility</span></button>` : ''}
          ${can('doctors', 'edit') ? `<button class="tbl-action-btn"><span class="material-symbols-outlined">edit</span></button>` : ''}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

async function showDoctor(id) {
  document.getElementById('doctorModalBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Loading…</div>`;
  document.getElementById('doctorModalFooterActions').innerHTML = '';
  currentDoctorModalId = id;
  openModal('doctorModal');
  try {
    const res = await apiGet(`/doctors/${id}`);
    renderDoctorDetail(res.data);
  } catch (err) {
    console.error('Failed to load doctor:', err);
    document.getElementById('doctorModalBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Could not load doctor profile</div>`;
  }
}

function renderDoctorDetail(d) {
  const perf = PERF_BY_DOCTOR[d._id] || {};
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = {};
  (d.weeklyAvailability || []).forEach(w => { byDay[w.day] = w.isAvailable; });

  document.getElementById('doctorModalBody').innerHTML = `
    <div class="doctor-modal-header">
      <div class="doctor-modal-avatar">${d.initials || ''}</div>
      <div>
        <div style="font-size:20px;font-weight:800;font-family:'Manrope',sans-serif">${d.fullName}</div>
        <div style="color:var(--color-secondary);font-weight:600;margin:2px 0">${d.specialization || ''}</div>
        <div class="text-muted">${d.qualification || ''}</div>
        <div class="text-muted" style="margin-top:4px"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">work</span> ${d.experienceYears != null ? d.experienceYears + ' years experience' : 'Experience not on file'}</div>
      </div>
    </div>
    <div class="form-row" style="row-gap:12px;margin-bottom:20px">
      <div><div class="form-label">Phone</div><div class="font-semibold text-sm">${d.phone || '—'}</div></div>
      <div><div class="form-label">Email</div><div class="font-semibold text-sm">${d.email || '—'}</div></div>
      <div><div class="form-label">Patients (30d)</div><div class="font-semibold text-sm">${perf.patients ?? '—'}</div></div>
      <div><div class="form-label">Completion Rate</div><div class="font-semibold text-sm">${perf.completionRate != null ? perf.completionRate + '%' : '—'}</div></div>
      <div><div class="form-label">Revenue (30d)</div><div class="font-semibold text-sm">${perf.revenue != null ? '$' + perf.revenue.toLocaleString('en-US') : '—'}</div></div>
      <div><div class="form-label">Status</div><span class="badge-status badge-${d.isAvailable ? 'available' : 'inactive'}">${d.isAvailable ? 'Available' : 'On Leave'}</span></div>
    </div>
    <div class="form-label" style="margin-bottom:10px">Weekly Availability</div>
    <div class="avail-schedule">
      ${dayNames.map(day => `
        <div class="avail-day ${byDay[day] ? 'available' : 'unavailable'}">
          <div class="day-label">${day}</div>
          <div class="day-dot">${byDay[day] ? '✓' : '—'}</div>
        </div>
      `).join('')}
    </div>
  `;

  const footerEl = document.getElementById('doctorModalFooterActions');
  if (footerEl) {
    footerEl.innerHTML = d.isAvailable
      ? `<button class="btn btn-primary" onclick="toggleDoctorAvailability('${d._id}', false)"><span class="material-symbols-outlined">event_busy</span> Mark On Leave</button>`
      : `<button class="btn btn-primary" onclick="toggleDoctorAvailability('${d._id}', true)"><span class="material-symbols-outlined">event_available</span> Mark Available</button>`;
  }
}
/* ============================================================
   ADD DOCTOR — real registration flow
   POST /api/doctors requires fullName, phone, specialization
   (server.js validateDoctorFields). Consultation hours, if set,
   are sent as Mon-Fri weeklyAvailability entries; Sat/Sun default
   to unavailable (server fills gaps via mergeWeeklyAvailability).
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[onclick*="openModal(\'addDoctorModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetNewDoctorForm);
  });
});

function resetNewDoctorForm() {
  ['newDocFullName', 'newDocQualification', 'newDocExperience', 'newDocPhone', 'newDocEmail'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Department select: reset to the placeholder and re-fetch, so a
  // department created/deactivated elsewhere is reflected each time
  // the modal is (re)opened.
  const specSel = document.getElementById('newDocSpecialization');
  if (specSel) specSel.value = '';
  loadDepartmentOptions();
  document.getElementById('newDocHoursStart').value = '09:00';
  document.getElementById('newDocHoursEnd').value = '17:00';
  hideNewDocError();
}

function showNewDocError(msg) {
  const el = document.getElementById('newDocError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideNewDocError() {
  const el = document.getElementById('newDocError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function submitNewDoctor() {
  hideNewDocError();
  const fullName = document.getElementById('newDocFullName').value.trim();
  const specialization = document.getElementById('newDocSpecialization').value.trim();
  const qualification = document.getElementById('newDocQualification').value.trim();
  const experienceRaw = document.getElementById('newDocExperience').value;
  const phone = document.getElementById('newDocPhone').value.trim();
  const email = document.getElementById('newDocEmail').value.trim();
  const hoursStart = document.getElementById('newDocHoursStart').value;
  const hoursEnd = document.getElementById('newDocHoursEnd').value;

  if (!fullName) return showNewDocError('Full name is required.');
  if (!phone) return showNewDocError('Phone number is required.');
  if (!specialization) return showNewDocError('Department is required.');

  const payload = {
    fullName, phone, specialization,
    qualification: qualification || undefined,
    email: email || undefined,
  };
  if (experienceRaw !== '') {
    const exp = Number(experienceRaw);
    if (!Number.isFinite(exp) || exp < 0) return showNewDocError('Experience must be a non-negative number.');
    payload.experienceYears = exp;
  }
  if (hoursStart && hoursEnd) {
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    payload.weeklyAvailability = weekdays.map(day => ({ day, isAvailable: true, startTime: hoursStart, endTime: hoursEnd }));
  }

  const btn = document.getElementById('newDocSubmitBtn');
  btn.disabled = true;
  try {
    await apiPost('/doctors', payload);
    showToast('Doctor added successfully!');
    closeModal('addDoctorModal');
    loadDoctors();
  } catch (err) {
    console.error('Failed to add doctor:', err);
    showNewDocError(err.message || 'Could not add doctor. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Availability toggle (PATCH /doctors/:id/status) ---------- */

let currentDoctorModalId = null;

async function toggleDoctorAvailability(id, makeAvailable) {
  try {
    await apiPatch(`/doctors/${id}/status`, { isAvailable: makeAvailable });
    showToast(makeAvailable ? 'Doctor marked as Available' : 'Doctor marked as On Leave');
    closeModal('doctorModal');
    loadDoctors();
  } catch (err) {
    console.error('Failed to update doctor status:', err);
    showToast('Could not update doctor status', 'error');
  }
}