/* CALENDAR JS — Phase: Hardcoded Data Removal Audit
   Data sources:
     GET /api/appointments?dateFrom=&dateTo=  — month's events, refetched on navigation
     GET /api/doctors                          — doctor filter list + color legend
   No mock EVENTS map, no hardcoded DOCTOR_COLORS. MongoDB via api.js
   is the single source of truth. */

let EVENTS = {};        // dateStr -> array of {time, patient, doctor, doctorId, type}
let DOCTORS = [];
let DOCTOR_COLORS = {}; // doctorId -> color, assigned from doctor.avatarColor

const _today = new Date();
let currentYear = _today.getFullYear(), currentMonth = _today.getMonth();
let selectedDate = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-${String(_today.getDate()).padStart(2, '0')}`;

const AV_COLOR_HEX = {
  'av-1': '#0061a4', 'av-2': '#006c48', 'av-3': '#7b2d8b',
  'av-4': '#e07b00', 'av-5': '#b83c00', 'av-6': '#2EBD85',
};

document.addEventListener('DOMContentLoaded', async () => {
  initLayout('calendar');
  // Phase 13.2 — nothing below runs if the user lacks calendar.view.
  const allowed = await window._appPageGuardReady;
  if (!allowed) return;

  await loadDoctors();
  await loadMonthEvents();
  renderCalendar();
  renderDoctorFilters();
  showDayAppointments(selectedDate);

  document.getElementById('prevBtn').onclick = async () => { currentMonth--; if (currentMonth < 0) { currentMonth = 11; currentYear--; } await loadMonthEvents(); renderCalendar(); };
  document.getElementById('nextBtn').onclick = async () => { currentMonth++; if (currentMonth > 11) { currentMonth = 0; currentYear++; } await loadMonthEvents(); renderCalendar(); };
  document.getElementById('todayBtn').onclick = async () => {
    const t = new Date();
    currentYear = t.getFullYear(); currentMonth = t.getMonth();
    selectedDate = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    await loadMonthEvents();
    renderCalendar();
    showDayAppointments(selectedDate);
  };

  document.querySelectorAll('.cal-view-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  applyCalendarPagePermissions();
});

/* ============================================================
   PAGE-LEVEL BUTTON PERMISSIONS (Phase 13.2)
   ============================================================ */
function applyCalendarPagePermissions() {
  if (!can('appointments', 'create')) {
    document.querySelector('[onclick="openModal(\'addApptModal\')"]')?.remove();
  }
}

async function loadDoctors() {
  try {
    const res = await apiGet('/doctors?limit=100');
    DOCTORS = res.data || [];
    DOCTORS.forEach(d => { DOCTOR_COLORS[d._id] = AV_COLOR_HEX[d.avatarColor] || '#2EBD85'; });
  } catch (err) {
    console.error('Failed to load doctors:', err);
  }
}

async function loadMonthEvents() {
  EVENTS = {};
  try {
    const from = new Date(currentYear, currentMonth, 1).toISOString().slice(0, 10);
    const to = new Date(currentYear, currentMonth + 1, 0).toISOString().slice(0, 10);
    const res = await apiGet(`/appointments?dateFrom=${from}&dateTo=${to}&limit=200`);
    (res.data || []).forEach(a => {
      const dateStr = (a.appointmentDate || '').slice(0, 10);
      if (!dateStr) return;
      if (!EVENTS[dateStr]) EVENTS[dateStr] = [];
      EVENTS[dateStr].push({
        time: a.startTime,
        patient: a.patientId?.fullName || 'Unknown',
        doctor: a.doctorId?.fullName || '',
        doctorId: a.doctorId?._id,
        type: a.type,
      });
    });
  } catch (err) {
    console.error('Failed to load month appointments:', err);
    showToast('Could not load calendar events', 'error');
  }
}

function renderCalendar() {
  const _now = new Date();
  const todayStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  document.getElementById('calTitle').textContent = new Date(currentYear, currentMonth, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const firstDay = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const daysInPrev = new Date(currentYear, currentMonth, 0).getDate();

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = `<div class="cal-grid-header">${days.map(d => `<div class="cal-day-label">${d}</div>`).join('')}</div><div class="cal-grid">`;

  for (let i = 0; i < firstDay; i++) {
    const d = daysInPrev - firstDay + i + 1;
    html += `<div class="cal-cell other-month"><div class="cal-cell-date">${d}</div></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const events = EVENTS[dateStr] || [];
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === selectedDate;
    const maxShow = 2;
    html += `<div class="cal-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}" data-date="${dateStr}">
      <div class="cal-cell-date">${d}</div>
      ${events.slice(0, maxShow).map(e => `<div class="cal-event" style="border-left:3px solid ${DOCTOR_COLORS[e.doctorId] || '#2EBD85'}">${e.time} ${e.patient}</div>`).join('')}
      ${events.length > maxShow ? `<div class="more-events">+${events.length - maxShow} more</div>` : ''}
    </div>`;
  }
  const remaining = 42 - firstDay - daysInMonth;
  for (let d = 1; d <= remaining; d++) { html += `<div class="cal-cell other-month"><div class="cal-cell-date">${d}</div></div>`; }
  html += '</div>';
  document.getElementById('calendarView').innerHTML = html;

  document.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      document.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');
      selectedDate = cell.dataset.date;
      document.getElementById('selectedDateLabel').textContent = new Date(selectedDate + 'T12:00:00').toLocaleDateString('default', { month: 'short', day: 'numeric' });
      showDayAppointments(selectedDate);
    });
  });
}

function showDayAppointments(date) {
  const events = EVENTS[date] || [];
  const el = document.getElementById('dayAppointments');
  if (!events.length) {
    el.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">No appointments on this day</div>';
    return;
  }
  el.innerHTML = `<div class="day-appt-list">${events.map(e => `
    <div class="day-appt-item" style="border-color:${DOCTOR_COLORS[e.doctorId] || '#2EBD85'}">
      <div class="day-appt-time">${e.time}</div>
      <div>
        <div style="font-size:13px;font-weight:600">${e.patient}</div>
        <div class="td-muted">${e.doctor}</div>
      </div>
    </div>
  `).join('')}</div>`;
}

function renderDoctorFilters() {
  if (!DOCTORS.length) {
    document.getElementById('doctorFilterList').innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">No doctors found</div>`;
    return;
  }
  document.getElementById('doctorFilterList').innerHTML = DOCTORS.map(d => `
    <div class="doctor-filter-item">
      <input type="checkbox" checked id="df_${d._id}">
      <div class="doctor-filter-dot" style="background:${DOCTOR_COLORS[d._id] || '#2EBD85'}"></div>
      <label class="doctor-filter-name" for="df_${d._id}">${d.fullName}</label>
    </div>
  `).join('');
}
/* ============================================================
   SCHEDULE APPOINTMENT (calendar view) — real submission flow
   POST /api/appointments — same shape as appointments.js's New
   Appointment form. Reuses DOCTORS already loaded for the filter
   panel; patient is resolved via live search.
   ============================================================ */

let _calPatientSearchDebounce = null;

document.addEventListener('DOMContentLoaded', () => {
  initCalendarApptModal();
});

function initCalendarApptModal() {
  const searchInput = document.getElementById('calApptPatientSearch');
  searchInput?.addEventListener('input', () => {
    document.getElementById('calApptPatientId').value = '';
    clearTimeout(_calPatientSearchDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      document.getElementById('calApptPatientResults').style.display = 'none';
      return;
    }
    _calPatientSearchDebounce = setTimeout(() => runCalApptPatientSearch(q), 250);
  });

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('calApptPatientResults');
    if (wrap && !e.target.closest('#calApptPatientResults') && e.target.id !== 'calApptPatientSearch') {
      wrap.style.display = 'none';
    }
  });

  // See appointments.js for why this is needed: without it, clicking
  // "Add as new patient" replaces the dropdown's innerHTML mid-click,
  // the click target becomes detached, and the handler above closes
  // the dropdown before the inline add-patient form can stay open.
  document.getElementById('calApptPatientResults')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.querySelectorAll('[onclick*="openModal(\'addApptModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetCalendarApptForm);
  });
}

async function runCalApptPatientSearch(q) {
  const resultsEl = document.getElementById('calApptPatientResults');
  try {
    const res = await apiGet(`/patients?search=${encodeURIComponent(q)}&limit=8`);
    const patients = res.data || [];
    const addNewRow = `
      <div class="psr-item psr-add-new" onclick="openInlineNewPatientCal('${q.replace(/'/g, "\\'")}')">
        <span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px">person_add</span>
        Add "${q}" as a new patient
      </div>
    `;
    resultsEl.innerHTML = (patients.length
      ? patients.map(p => `
          <div class="psr-item" onclick="selectCalApptPatient('${p._id}', '${(p.fullName || '').replace(/'/g, "\\'")}')">
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

function selectCalApptPatient(id, name) {
  document.getElementById('calApptPatientId').value = id;
  document.getElementById('calApptPatientSearch').value = name;
  document.getElementById('calApptPatientResults').style.display = 'none';
}

function populateCalApptDoctorSelect() {
  const select = document.getElementById('calApptDoctorId');
  if (!select) return;
  select.innerHTML = DOCTORS.length
    ? '<option value="">Select doctor…</option>' + DOCTORS.map(d => `<option value="${d._id}">${d.fullName}${d.specialization ? ' — ' + d.specialization : ''}</option>`).join('')
    : '<option value="">No doctors found</option>';
}

function resetCalendarApptForm() {
  document.getElementById('calApptPatientSearch').value = '';
  document.getElementById('calApptPatientId').value = '';
  document.getElementById('calApptPatientResults').style.display = 'none';
  document.getElementById('calApptStartTime').value = '09:00';
  document.getElementById('calApptEndTime').value = '09:30';
  document.getElementById('calApptType').value = 'Consultation';
  document.getElementById('calApptNotes').value = '';
  document.getElementById('calApptModalDate').value = selectedDate || new Date().toISOString().slice(0, 10);
  hideCalApptError();
  populateCalApptDoctorSelect();
}

function showCalApptError(msg) {
  const el = document.getElementById('calApptError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideCalApptError() {
  const el = document.getElementById('calApptError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function submitCalendarAppointment() {
  hideCalApptError();
  const patientId = document.getElementById('calApptPatientId').value;
  const doctorId = document.getElementById('calApptDoctorId').value;
  const appointmentDate = document.getElementById('calApptModalDate').value;
  const startTime = document.getElementById('calApptStartTime').value;
  const endTime = document.getElementById('calApptEndTime').value;
  const type = document.getElementById('calApptType').value;
  const notes = document.getElementById('calApptNotes').value;

  if (!patientId) return showCalApptError('Please select a patient from the search results.');
  if (!doctorId) return showCalApptError('Please select a doctor.');
  if (!appointmentDate) return showCalApptError('Please select a date.');
  if (!startTime || !endTime) return showCalApptError('Please set start and end time.');
  if (startTime >= endTime) return showCalApptError('Start time must be before end time.');

  const payload = { patientId, doctorId, appointmentDate, startTime, endTime, type, notes };

  const btn = document.getElementById('calApptSubmitBtn');
  btn.disabled = true;
  try {
    await apiPost('/appointments', payload);
    showToast('Appointment scheduled!');
    closeModal('addApptModal');
    await loadMonthEvents();
    renderCalendar();
    showDayAppointments(selectedDate);
  } catch (err) {
    console.error('Failed to schedule appointment:', err);
    showCalApptError(err.message || 'Could not schedule appointment. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}
/* ============================================================
   INLINE QUICK-ADD PATIENT (calendar's Schedule Appointment modal)
   Same pattern as appointments.js — lets staff register a new
   patient without leaving the booking form. POST /api/patients.
   ============================================================ */

function openInlineNewPatientCal(prefillName) {
  const resultsEl = document.getElementById('calApptPatientResults');
  resultsEl.innerHTML = `
    <div class="psr-inline-form">
      <input class="form-input" id="inlineNewPatNameCal" placeholder="Full name" value="${prefillName.replace(/"/g, '&quot;')}" style="margin-bottom:6px">
      <input class="form-input" id="inlineNewPatPhoneCal" placeholder="Phone number" style="margin-bottom:6px">
      <div id="inlineNewPatErrorCal" class="text-sm" style="color:var(--color-error);display:none;margin-bottom:6px"></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="document.getElementById('calApptPatientResults').style.display='none'">Cancel</button>
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="submitInlineNewPatientCal()">Save & Select</button>
      </div>
    </div>
  `;
  resultsEl.style.display = 'block';
  document.getElementById('inlineNewPatPhoneCal').focus();
}

async function submitInlineNewPatientCal() {
  const nameEl = document.getElementById('inlineNewPatNameCal');
  const phoneEl = document.getElementById('inlineNewPatPhoneCal');
  const errEl = document.getElementById('inlineNewPatErrorCal');
  const fullName = nameEl.value.trim();
  const phone = phoneEl.value.trim();

  errEl.style.display = 'none';
  if (!fullName) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
  if (!phone) { errEl.textContent = 'Phone number is required.'; errEl.style.display = 'block'; return; }

  try {
    const res = await apiPost('/patients', { fullName, phone, gender: 'Other' });
    const newPatient = res.data;
    showToast('Patient registered and selected');
    selectCalApptPatient(newPatient._id, newPatient.fullName);
  } catch (err) {
    console.error('Failed to quick-add patient:', err);
    errEl.textContent = err.message || 'Could not save patient. Please check the details.';
    errEl.style.display = 'block';
  }
}