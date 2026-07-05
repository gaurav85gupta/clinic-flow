/* PATIENTS JS — Phase: Hardcoded Data Removal Audit
   Data source: GET /api/patients (list), GET /api/patients/:id (detail)
   No mock arrays. MongoDB via api.js is the single source of truth. */

let PATIENTS = [];          // current page of patients, from the API
let patientSearchTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initLayout('patients');
  // Phase 13.2 — nothing below runs if the user lacks patients.view;
  // initLayout() has already swapped in the Access Denied screen.
  window._appPageGuardReady.then(allowed => {
    if (!allowed) return;
    loadPatients();
    loadPatientGrowthStats();
    document.getElementById('patientSearch')?.addEventListener('input', e => {
      clearTimeout(patientSearchTimer);
      const q = e.target.value;
      patientSearchTimer = setTimeout(() => loadPatients({ search: q }), 300);
    });

    // Deep link from the global header search (global.js: goToPatient)
    // — opens this patient's detail modal directly on arrival.
    const openId = new URLSearchParams(window.location.search).get('openPatient');
    if (openId) showPatient(openId);

    initPatientsExport();
    applyPatientsPagePermissions();
  });
});

/* ============================================================
   PAGE-LEVEL BUTTON PERMISSIONS (Phase 13.2)
   Add Patient / Export are static header buttons — removed outright
   rather than disabled. Row-level actions (View/Edit/Book) are
   handled inside renderPatients() below since that markup doesn't
   exist yet at DOMContentLoaded time.
   ============================================================ */
function applyPatientsPagePermissions() {
  if (!can('patients', 'create')) {
    document.querySelector('[onclick="openModal(\'addPatientModal\')"]')?.remove();
  }
  if (!can('patients', 'export')) {
    document.querySelectorAll('.page-header-actions .btn-secondary').forEach(btn => {
      if (btn.textContent.includes('Export')) btn.remove();
    });
  }
  if (!can('appointments', 'create')) {
    document.getElementById('patientDetailBookBtn')?.remove();
  }
}

/* ---------- Export (Phase 12.2) ----------
   Respects the current search box; "Export All" pages through every
   matching patient via GET /patients, "Current Page Only" reuses the
   already-loaded PATIENTS array. Same fields as the table. */
function initPatientsExport() {
  initExportButton({
    buttonSelector: '.page-header-actions .btn-secondary',
    title: 'Patients',
    getFilenameBase: () => `Patients_${exportFmtDateStamp()}`,
    supportsScope: true,
    hasCurrentPageData: () => PATIENTS.length > 0,
    buildRows: async (scope) => {
      const search = document.getElementById('patientSearch')?.value || '';
      let data;
      if (scope === 'page') {
        data = PATIENTS;
      } else {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        const qs = params.toString();
        data = await exportFetchAllPages(`/patients${qs ? '?' + qs : ''}`);
      }
      const headers = ['Patient ID', 'Name', 'Age', 'Gender', 'Phone', 'Blood Group', 'Last Visit', 'Status'];
      const rows = data.map(p => [
        p.patientId || '',
        p.fullName || '',
        p.age != null ? p.age : '',
        p.gender || '',
        p.phone || '',
        p.bloodGroup || '',
        exportFmtDate(p.lastVisitAt),
        p.isActive ? 'Active' : 'Inactive',
      ]);
      return { headers, rows, sheetName: 'Patients' };
    },
  });
}

// Header subtitle + side-panel growth card. Sourced from
// GET /api/reports/overview (activePatients, newPatients.thisMonth)
// — same numbers the dashboard's executive summary uses — plus a
// direct count for "Inactive" since the overview report doesn't
// break that out.
async function loadPatientGrowthStats() {
  try {
    const [overviewRes, inactiveRes] = await Promise.all([
      apiGet('/reports/overview'),
      apiGet('/patients?isActive=false&limit=1'),
    ]);
    const o = overviewRes.data;
    const totalPatients = o.activePatients + (inactiveRes.pagination?.total || 0);
    setText('patientsHeaderSubtitle', `${totalPatients.toLocaleString('en-US')} registered patients · ${o.newPatients.thisMonth} new this month`);
    setText('gsTotalPatients', totalPatients.toLocaleString('en-US'));
    setText('gsThisMonth', '+' + o.newPatients.thisMonth);
    setText('gsActive', o.activePatients.toLocaleString('en-US'));
    setText('gsInactive', (inactiveRes.pagination?.total || 0).toLocaleString('en-US'));
  } catch (err) {
    console.error('Failed to load patient growth stats:', err);
    setText('patientsHeaderSubtitle', 'Could not load patient stats');
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function loadPatients(params = {}) {
  const tbody = document.getElementById('patientTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">Loading patients…</td></tr>`;
  try {
    const query = new URLSearchParams(params).toString();
    const res = await apiGet(`/patients${query ? '?' + query : ''}`);
    PATIENTS = res.data || [];
    renderPatients(PATIENTS);
    renderPatientPagination(res.pagination);
  } catch (err) {
    console.error('Failed to load patients:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">Could not load patients</td></tr>`;
    showToast('Could not load patients', 'error');
  }
}

function renderPatientPagination(pagination) {
  const el = document.querySelector('.pagination span');
  if (el && pagination) {
    const start = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.page * pagination.limit, pagination.total);
    el.textContent = `Showing ${start}–${end} of ${pagination.total.toLocaleString('en-US')} patients`;
  }
}

// Patient documents carry no avatar color / initials field (only
// Doctor does — see server.js patientSchema vs doctorSchema). Both
// are derived client-side here, purely for display.
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
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

function renderPatients(data) {
  const tbody = document.getElementById('patientTableBody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="padding:16px">No patients found</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(p => `
    <tr style="cursor:pointer" onclick="showPatient('${p._id}')">
      <td>
        <div class="flex items-center gap-sm">
          <div class="table-avatar ${avatarClassFor(p._id)}">${initialsFromName(p.fullName)}</div>
          <div>
            <div class="td-primary">${p.fullName || 'Unknown'}</div>
            <div class="td-muted">${p.patientId || ''}</div>
          </div>
        </div>
      </td>
      <td><div class="td-primary">${p.age != null ? p.age + ' yrs' : '—'}</div><div class="td-muted">${p.gender || ''}</div></td>
      <td><div class="td-primary" style="font-size:12px">${p.phone || ''}</div><div class="td-muted">${p.email || ''}</div></td>
      <td><div class="td-muted">—</div></td>
      <td><div class="td-muted">${fmtDate(p.lastVisitAt)}</div></td>
      <td><span class="badge-status badge-${p.isActive ? 'active' : 'inactive'}">${p.isActive ? 'active' : 'inactive'}</span></td>
      <td>
        <div class="action-btn-group">
          ${canView('patients') ? `<button class="tbl-action-btn" title="View" onclick="event.stopPropagation();showPatient('${p._id}')"><span class="material-symbols-outlined">visibility</span></button>` : ''}
          ${can('patients', 'edit') ? `<button class="tbl-action-btn" title="Edit" onclick="event.stopPropagation();openEditPatient('${p._id}')"><span class="material-symbols-outlined">edit</span></button>` : ''}
          ${can('appointments', 'create') ? `<button class="tbl-action-btn" title="Book Appointment" onclick="event.stopPropagation();bookAppointmentFor('${p._id}','${(p.fullName || '').replace(/'/g, "\\'")}')"><span class="material-symbols-outlined">event_available</span></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

let currentPatientDetailId = null;
let currentPatientDetailName = null;

async function showPatient(id) {
  document.getElementById('patientDetailBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Loading…</div>`;
  openModal('patientDetailModal');
  try {
    const res = await apiGet(`/patients/${id}`);
    currentPatientDetailId = res.data._id;
    currentPatientDetailName = res.data.fullName || '';
    renderPatientDetail(res.data);
  } catch (err) {
    console.error('Failed to load patient:', err);
    document.getElementById('patientDetailBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Could not load patient details</div>`;
  }
}

// Navigates to Appointments with the patient pre-selected so the
// "New Appointment" modal opens ready to book, instead of leaving
// this as a dead button. Appointments page reads these via
// sessionStorage on load (see appointments.js: consumePrefillPatient).
function bookAppointmentFor(id, name) {
  if (!id) return;
  sessionStorage.setItem('medicore_prefill_patient', JSON.stringify({ id, name: name || '' }));
  window.location.href = 'appointments.html?bookFor=' + encodeURIComponent(id);
}

function renderPatientDetail(p) {
  document.getElementById('patientDetailBody').innerHTML = `
    <div class="patient-modal-header">
      <div class="patient-modal-avatar ${avatarClassFor(p._id)}">${initialsFromName(p.fullName)}</div>
      <div>
        <div style="font-size:20px;font-weight:800;font-family:'Manrope',sans-serif">${p.fullName || 'Unknown'}</div>
        <div class="text-muted" style="margin:2px 0">${p.patientId || ''} · ${p.age != null ? p.age + ' yrs' : '—'} · ${p.gender || ''}</div>
        <span class="badge-status badge-${p.isActive ? 'active' : 'inactive'}">${p.isActive ? 'active' : 'inactive'}</span>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div style="font-size:20px;font-weight:800;color:var(--color-error);font-family:'Manrope',sans-serif">${p.bloodGroup || '—'}</div>
        <div class="td-muted">Blood Group</div>
      </div>
    </div>
    <div class="form-row" style="row-gap:12px;margin-bottom:16px">
      <div><div class="form-label">Phone</div><div class="font-semibold text-sm">${p.phone || '—'}</div></div>
      <div><div class="form-label">Email</div><div class="font-semibold text-sm">${p.email || '—'}</div></div>
      <div><div class="form-label">Last Visit</div><div class="font-semibold text-sm">${fmtDate(p.lastVisitAt)}</div></div>
      <div><div class="form-label">Total Visits</div><div class="font-semibold text-sm">${p.totalVisits ?? 0}</div></div>
    </div>
    <div class="divider"></div>
    <div style="margin-bottom:12px"><div class="form-label">Known Conditions / Allergies</div>
      <div style="background:var(--color-error-container);color:var(--color-error);border-radius:var(--radius-md);padding:10px 14px;font-size:13px;font-weight:600;margin-top:6px">${[...(p.medicalConditions||[]), ...(p.allergies||[])].join(', ') || 'None recorded'}</div>
    </div>
    <!-- NOTE: A per-patient visit timeline has no dedicated API endpoint yet.
         GET /api/appointments?patientId= returns the patient's appointment
         history and could power this list — left out here rather than
         inventing fake visit rows. See audit report: "Missing endpoints". -->
  `;
}
/* ============================================================
   ADD PATIENT — real registration flow
   POST /api/patients requires fullName, phone, gender (server.js
   validatePatientFields). dateOfBirth/email/bloodGroup/address/
   allergies/medicalConditions are optional but typed — see schema.
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[onclick*="openModal(\'addPatientModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetNewPatientForm);
  });
});

// null while adding a new patient; set to the patient's _id while
// editing an existing one so submitNewPatient() knows whether to
// POST /patients or PUT /patients/:id.
let editingPatientId = null;

function resetNewPatientForm() {
  editingPatientId = null;
  ['newPatFullName', 'newPatPhone', 'newPatDob', 'newPatEmail', 'newPatStreet', 'newPatCity', 'newPatConditions'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const gEl = document.getElementById('newPatGender');
  if (gEl) gEl.value = 'Male';
  const bEl = document.getElementById('newPatBloodGroup');
  if (bEl) bEl.value = '';
  hideNewPatError();
  setPatientModalMode('add');
}

function setPatientModalMode(mode) {
  const titleEl = document.querySelector('#addPatientModal .modal-title');
  const btnEl = document.getElementById('newPatSubmitBtn');
  if (mode === 'edit') {
    if (titleEl) titleEl.textContent = 'Edit Patient';
    if (btnEl) btnEl.innerHTML = '<span class="material-symbols-outlined">check</span> Save Changes';
  } else {
    if (titleEl) titleEl.textContent = 'Register New Patient';
    if (btnEl) btnEl.innerHTML = '<span class="material-symbols-outlined">check</span> Register Patient';
  }
}

// Loads the patient, fills the (reused) Add Patient modal with their
// current details, and flips it into edit mode.
async function openEditPatient(id) {
  hideNewPatError();
  openModal('addPatientModal');
  setPatientModalMode('edit');
  editingPatientId = id;
  try {
    const res = await apiGet(`/patients/${id}`);
    const p = res.data;
    document.getElementById('newPatFullName').value = p.fullName || '';
    document.getElementById('newPatPhone').value = p.phone || '';
    document.getElementById('newPatDob').value = p.dateOfBirth ? new Date(p.dateOfBirth).toISOString().slice(0, 10) : '';
    document.getElementById('newPatGender').value = p.gender || 'Male';
    document.getElementById('newPatEmail').value = p.email || '';
    document.getElementById('newPatBloodGroup').value = p.bloodGroup || '';
    document.getElementById('newPatStreet').value = p.address?.street || '';
    document.getElementById('newPatCity').value = p.address?.city || '';
    document.getElementById('newPatConditions').value = [...(p.medicalConditions || []), ...(p.allergies || [])].join(', ');
  } catch (err) {
    console.error('Failed to load patient for edit:', err);
    showNewPatError('Could not load patient details for editing.');
  }
}

function showNewPatError(msg) {
  const el = document.getElementById('newPatError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideNewPatError() {
  const el = document.getElementById('newPatError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function submitNewPatient() {
  hideNewPatError();
  const fullName = document.getElementById('newPatFullName').value.trim();
  const phone = document.getElementById('newPatPhone').value.trim();
  const gender = document.getElementById('newPatGender').value;
  const dateOfBirth = document.getElementById('newPatDob').value;
  const email = document.getElementById('newPatEmail').value.trim();
  const bloodGroup = document.getElementById('newPatBloodGroup').value;
  const street = document.getElementById('newPatStreet').value.trim();
  const city = document.getElementById('newPatCity').value.trim();
  const conditionsRaw = document.getElementById('newPatConditions').value.trim();

  if (!fullName) return showNewPatError('Full name is required.');
  if (!phone) return showNewPatError('Phone number is required.');

  const payload = {
    fullName, phone, gender,
    dateOfBirth: dateOfBirth || undefined,
    email: email || undefined,
    bloodGroup: bloodGroup || undefined,
  };
  if (street || city) payload.address = { street: street || undefined, city: city || undefined };
  if (conditionsRaw) {
    payload.medicalConditions = conditionsRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  const btn = document.getElementById('newPatSubmitBtn');
  btn.disabled = true;
  try {
    if (editingPatientId) {
      await apiPut(`/patients/${editingPatientId}`, payload);
      showToast('Patient updated successfully!');
    } else {
      await apiPost('/patients', payload);
      showToast('Patient registered successfully!');
    }
    closeModal('addPatientModal');
    loadPatients();
    loadPatientGrowthStats();
  } catch (err) {
    console.error('Failed to save patient:', err);
    showNewPatError(err.message || 'Could not save patient. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}