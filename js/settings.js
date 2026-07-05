/* SETTINGS JS — Phase 15.0: Notifications + Appointment Duration wiring
   Data sources:
     GET/PUT /api/clinic    — clinic name, phone, email, address, tagline
     GET/PUT /api/settings  — working hours, appointmentDuration, currency,
                              taxPercentage, emailEnabled, smsEnabled,
                              whatsappEnabled
     GET/POST/PUT /api/staff, PATCH /api/staff/:id/status,
     PATCH /api/staff/:id/reset-password — staff directory (clinic_admin
     only; role: doctor or receptionist).

   Phase 15.0 additions vs Phase 14.0:
     — appointmentDuration field wired to GET/PUT /api/settings
     — Notifications tab: emailEnabled, smsEnabled, whatsappEnabled
       toggles now load from GET /api/settings and save via PUT /api/settings
     — Branding tab: tagline field wired to PUT /api/clinic
     — saveAll() is now tab-aware: only sends the payload relevant to the
       currently-active tab so unrelated tabs don't send empty/stale fields
     — "Discard Changes" button wired to reload all live data from server

   NOTE: Fields that remain static UI (no backend field):
     Clinic tab  — Registration Number, Working Days checkboxes, Specializations
     Billing tab — Invoice Prefix, Invoice Due Days, Payment Methods, GST Number
     Security tab — all toggles + password fields (no schema support)
     Integrations tab — all cards (no schema support)
     Branding tab — Primary Color / App Name (no schema support)
   Phase 13.0 additions:
     — Role Permissions matrix (Staff tab) is now fully database-driven:
       GET /api/permissions loads the matrix, PUT /api/permissions saves
       edits, POST /api/permissions/reset restores defaults. Editing is
       gated client-side on the logged-in user's role (clinic_admin only)
       as a UX convenience — the server enforces this independently via
       authorize('clinic_admin'), so this is not a security boundary. */

/* ============================================================
   BOOT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initLayout('settings');
  // Phase 13.2 — nothing below runs if the user lacks settings.view.
  // (buildDefaultMatrix in server.js only grants the settings module
  // to clinic_admin — every other role is NO_ACCESS — so in practice
  // this whole page is clinic_admin-only, but the check stays generic
  // rather than hardcoding that role name.)
  window._appPageGuardReady.then(allowed => {
    if (!allowed) return;
    loadClinicInfo();
    loadClinicSettings();   // also loads notification toggles + appointmentDuration
    loadStaff();
    loadDepartments();
    loadPermissionMatrixEditor();
    initSettingsTabs();
    initColorSwatches();
    initDiscardBtn();
    initPermissionMatrixControls();
    document.getElementById('saveSettingsBtn')?.addEventListener('click', saveCurrentTab);
    applySettingsTabPermissions();
  });
});

/* ============================================================
   SETTINGS TAB PERMISSIONS (Phase 13.2)
   Staff Management and Departments are their own permission modules
   (staff.view / departments.view); every other tab (Clinic Info,
   Branding, Notifications, Billing Settings, Security, Integrations)
   is edited through PUT /api/clinic or PUT /api/settings, both gated
   server-side on settings.manage — so those tabs collectively gate
   on the settings module. Removes both the nav item and its content
   pane so a hidden tab can never be reached by id even via dev tools,
   and re-activates the Clinic Info tab if it was the one removed.
   ============================================================ */
function applySettingsTabPermissions() {
  const tabPermissions = {
    staff: () => canView('staff'),
    departments: () => canView('departments'),
    clinic: () => canView('settings'),
    branding: () => canView('settings'),
    notifications: () => canView('settings'),
    billing_settings: () => canView('settings'),
    security: () => canView('settings'),
    integrations: () => canView('settings'),
  };

  let removedActiveTab = false;
  Object.entries(tabPermissions).forEach(([tabId, check]) => {
    if (check()) return;
    const navItem = document.querySelector(`.settings-nav-item[data-tab="${tabId}"]`);
    const pane = document.getElementById('tab-' + tabId);
    if (navItem?.classList.contains('active')) removedActiveTab = true;
    navItem?.remove();
    pane?.remove();
  });

  // If every tab this role can see was removed (fully locked out),
  // guardPageAccess() would already have blocked the whole page via
  // settings.view — reaching here means at least one tab remains.
  if (removedActiveTab) {
    const firstRemaining = document.querySelector('.settings-nav-item');
    if (firstRemaining) {
      firstRemaining.classList.add('active');
      document.getElementById('tab-' + firstRemaining.dataset.tab)?.classList.add('active');
    }
  }

  // "Add Staff" / "Add Department" header buttons within their tabs
  if (!can('staff', 'create')) {
    document.querySelector('[onclick="openModal(\'addStaffModal\')"]')?.remove();
  }
  if (!can('departments', 'create')) {
    document.querySelector('[onclick="openModal(\'addDepartmentModal\')"]')?.remove();
  }

  // Global "Save Changes" button only applies to the settings-managed
  // tabs (Clinic/Branding/Notifications/Billing/Security/Integrations),
  // all of which require settings.manage server-side (PUT /api/clinic,
  // PUT /api/settings). Staff/Departments save through their own
  // modals and are unaffected by this.
  if (!can('settings', 'manage')) {
    document.getElementById('saveSettingsBtn')?.remove();
  }
}

/* ============================================================
   LOAD — Clinic Info  (GET /api/clinic)
   ============================================================ */

async function loadClinicInfo() {
  try {
    const res = await apiGet('/clinic');
    const c = res.data;
    setVal('clinicName',    c.name);
    setVal('clinicPhone',   c.phone);
    setVal('clinicEmail',   c.ownerEmail);
    setVal('clinicStreet',  c.address?.street);
    setVal('clinicCity',    c.address?.city);
    setVal('clinicPincode', c.address?.pincode);
    setVal('clinicTagline', c.branding?.tagline);
  } catch (err) {
    console.error('Failed to load clinic info:', err);
    showToast('Could not load clinic information', 'error');
  }
}

/* ============================================================
   LOAD — Settings  (GET /api/settings)
   Covers: Clinic tab (working hours, appt duration),
           Billing tab (currency, tax),
           Notifications tab (emailEnabled, smsEnabled, whatsappEnabled)
   ============================================================ */

async function loadClinicSettings() {
  try {
    const res = await apiGet('/settings');
    const s = res.data;

    // Clinic tab fields
    setVal('workingHoursStart',    s.workingHours?.start);
    setVal('workingHoursEnd',      s.workingHours?.end);
    setVal('appointmentDuration',  s.appointmentDuration);

    // Billing tab fields
    setVal('settingsCurrency',      s.currency);
    setVal('settingsTaxPercentage', s.taxPercentage);

    // Notifications tab — three backend-backed toggles
    setToggle('notifEmail',     s.emailEnabled);
    setToggle('notifSms',       s.smsEnabled);
    setToggle('notifWhatsapp',  s.whatsappEnabled);

  } catch (err) {
    console.error('Failed to load clinic settings:', err);
    showToast('Could not load settings', 'error');
  }
}

/* ============================================================
   HELPERS
   ============================================================ */

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined && val !== null) el.value = val;
}
function getVal(id) {
  return document.getElementById(id)?.value;
}

/** Set a checkbox by element id */
function setToggle(id, boolVal) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(boolVal);
}
/** Read a checkbox by element id */
function getToggle(id) {
  return document.getElementById(id)?.checked ?? false;
}

/* ============================================================
   SAVE — tab-aware
   Only the active tab's payload is sent so unrelated tabs
   never submit empty/stale values.
   ============================================================ */

function getActiveTabId() {
  const active = document.querySelector('.settings-tab.active');
  return active ? active.id : null; // e.g. "tab-clinic"
}

async function saveCurrentTab() {
  const btn = document.getElementById('saveSettingsBtn');
  if (btn) btn.disabled = true;

  try {
    const tabId = getActiveTabId();

    if (tabId === 'tab-clinic') {
      await saveClinicTab();
    } else if (tabId === 'tab-notifications') {
      await saveNotificationsTab();
    } else if (tabId === 'tab-billing_settings') {
      await saveBillingTab();
    } else if (tabId === 'tab-branding') {
      await saveBrandingTab();
    } else {
      // Staff, Security, Integrations — no backend writes from Save Changes
      showToast('No saveable settings on this tab', 'info');
    }
  } catch (err) {
    // Individual save functions call showToast on error already
    console.error('Save failed:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Clinic tab ---------- */
async function saveClinicTab() {
  try {
    await Promise.all([
      apiPut('/clinic', {
        name:  getVal('clinicName'),
        phone: getVal('clinicPhone'),
        email: getVal('clinicEmail'),
        address: {
          street:  getVal('clinicStreet'),
          city:    getVal('clinicCity'),
          pincode: getVal('clinicPincode'),
        },
      }),
      apiPut('/settings', {
        workingHours: {
          start: getVal('workingHoursStart'),
          end:   getVal('workingHoursEnd'),
        },
        appointmentDuration: Number(getVal('appointmentDuration')) || 30,
      }),
    ]);
    showToast('Clinic information saved!');
  } catch (err) {
    console.error('Failed to save clinic tab:', err);
    showToast('Could not save clinic information', 'error');
    throw err;
  }
}

/* ---------- Notifications tab ---------- */
async function saveNotificationsTab() {
  try {
    await apiPut('/settings', {
      emailEnabled:    getToggle('notifEmail'),
      smsEnabled:      getToggle('notifSms'),
      whatsappEnabled: getToggle('notifWhatsapp'),
    });
    showToast('Notification settings saved!');
  } catch (err) {
    console.error('Failed to save notifications:', err);
    showToast('Could not save notification settings', 'error');
    throw err;
  }
}

/* ---------- Billing tab ---------- */
async function saveBillingTab() {
  try {
    await apiPut('/settings', {
      currency:      getVal('settingsCurrency'),
      taxPercentage: Number(getVal('settingsTaxPercentage')) || 0,
    });
    showToast('Billing settings saved!');
  } catch (err) {
    console.error('Failed to save billing settings:', err);
    showToast('Could not save billing settings', 'error');
    throw err;
  }
}

/* ---------- Branding tab ---------- */
async function saveBrandingTab() {
  try {
    const tagline = getVal('clinicTagline');
    // Only send fields that have a backend target. Color/App Name are
    // client-side only and intentionally not sent.
    const payload = {};
    if (tagline !== undefined) payload.tagline = tagline;

    if (Object.keys(payload).length === 0) {
      showToast('No saveable branding fields on this tab', 'info');
      return;
    }
    await apiPut('/clinic', payload);
    showToast('Branding saved!');
  } catch (err) {
    console.error('Failed to save branding:', err);
    showToast('Could not save branding settings', 'error');
    throw err;
  }
}

/* ============================================================
   DISCARD — reload live data from server
   ============================================================ */

function initDiscardBtn() {
  const btns = document.querySelectorAll('.page-header-actions .btn');
  btns.forEach(btn => {
    if (btn.textContent.trim() === 'Discard Changes') {
      btn.addEventListener('click', discardChanges);
    }
  });
}

async function discardChanges() {
  await Promise.allSettled([loadClinicInfo(), loadClinicSettings()]);
  showToast('Changes discarded — reloaded from server', 'info');
}

/* ============================================================
   TABS
   ============================================================ */

function initSettingsTabs() {
  const navItems = document.querySelectorAll('.settings-nav-item');
  const tabs = document.querySelectorAll('.settings-tab');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));
      item.classList.add('active');
      const tabId = 'tab-' + item.dataset.tab;
      const tab = document.getElementById(tabId);
      if (tab) tab.classList.add('active');
    });
  });
}

function initColorSwatches() {
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  });
}

/* ============================================================
   STAFF MANAGEMENT (Phase 14.0 — unchanged)
   GET/POST  /api/staff
   GET/PUT   /api/staff/:id
   PATCH     /api/staff/:id/status
   PATCH     /api/staff/:id/reset-password
   clinic_admin only — server.js authorize('clinic_admin') on every
   route. Scoped to role: doctor | receptionist (see STAFF_ROLES in
   server.js); other roles are out of scope for this module.
   ============================================================ */

let STAFF = [];

const STAFF_ROLE_LABELS = { doctor: 'Doctor', receptionist: 'Receptionist' };

// Phase 12.1 (Staff Identity Linking) — cache of the last-loaded
// available-doctors list per modal, keyed by doctor _id, so
// onStaffDoctorSelect() can read fullName/specialization back out
// without a second network call every time the dropdown changes.
let AVAILABLE_DOCTORS_CACHE = { new: {}, edit: {} };

async function loadStaff() {
  const el = document.getElementById('staffList');
  if (el) el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Loading staff…</div>`;
  try {
    const res = await apiGet('/staff?limit=100');
    STAFF = res.data || [];
    renderStaffList(STAFF);
  } catch (err) {
    console.error('Failed to load staff:', err);
    if (el) el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Could not load staff directory</div>`;
    showToast('Could not load staff directory', 'error');
  }
}

function staffInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function fmtStaffDate(d) {
  if (!d) return 'Never logged in';
  return 'Last login ' + new Date(d).toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderStaffList(data) {
  const el = document.getElementById('staffList');
  if (!el) return;
  if (!data.length) {
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">No staff members yet — use "Add Staff" to create a receptionist or doctor login.</div>`;
    return;
  }
  el.innerHTML = data.map(s => `
    <div class="staff-item">
      <div class="table-avatar av-${(s._id ? s._id.toString().charCodeAt(s._id.toString().length - 1) % 6 : 0) + 1}">${staffInitials(s.fullName)}</div>
      <div class="staff-item-info">
        <div class="staff-item-name">${s.fullName}</div>
        <div class="staff-item-meta">${STAFF_ROLE_LABELS[s.role] || s.role} · @${s.username || '—'} · ${s.phone || '—'} · ${fmtStaffDate(s.lastLoginAt)}</div>
      </div>
      <span class="badge-status badge-${s.isActive ? 'active' : 'inactive'}">${s.isActive ? 'Active' : 'Disabled'}</span>
      <div class="staff-actions">
        ${can('staff', 'edit') ? `<button class="tbl-action-btn" title="Edit" onclick="openEditStaffModal('${s._id}')"><span class="material-symbols-outlined">edit</span></button>` : ''}
        ${can('staff', 'manage') ? `<button class="tbl-action-btn" title="Reset password" onclick="openResetStaffPasswordModal('${s._id}')"><span class="material-symbols-outlined">key</span></button>` : ''}
        ${can('staff', 'delete') ? `<button class="tbl-action-btn" title="${s.isActive ? 'Deactivate' : 'Activate'}" onclick="toggleStaffStatus('${s._id}', ${!s.isActive})"><span class="material-symbols-outlined">${s.isActive ? 'block' : 'check_circle'}</span></button>` : ''}
      </div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[onclick*="openModal(\'addStaffModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetNewStaffForm);
  });
});

/* ============================================================
   PHASE 12.1 — STAFF IDENTITY LINKING (Doctor dropdown)
   Shared by the Add Staff and Edit Staff modals. `prefix` is
   'new' or 'edit', matching the id naming convention used
   throughout this file (newStaffX / editStaffX).
   ============================================================ */

// Toggles the Full Name field vs the Select Doctor dropdown based on
// the chosen role, and (re)loads the doctor list when switching to
// Doctor. Called on the Role <select>'s onchange for the Add modal;
// the Edit modal's role is locked (see settings.html) so this only
// runs there once, from openEditStaffModal(), to set initial state.
async function onStaffRoleChange(prefix, opts) {
  opts = opts || {};
  const role = document.getElementById(`${prefix}StaffRole`).value;
  const nameGroup = document.getElementById(`${prefix}StaffFullNameGroup`);
  const doctorGroup = document.getElementById(`${prefix}StaffDoctorGroup`);
  const nameInput = document.getElementById(`${prefix}StaffFullName`);

  if (role === 'doctor') {
    nameGroup.style.display = 'none';
    doctorGroup.style.display = 'block';
    // Manual name entry is not allowed for doctor logins (Phase 12.1)
    // — Full Name is derived from the linked Doctor profile instead.
    nameInput.value = '';
    await loadAvailableDoctorsDropdown(prefix, opts.includeId);
  } else {
    nameGroup.style.display = 'block';
    doctorGroup.style.display = 'none';
  }
}

// Populates the "Select Doctor" / "Linked Doctor" dropdown from
// GET /api/staff/available-doctors — unlinked, active doctors only
// (plus includeId's doctor, when editing an existing doctor login,
// so its own current doctor doesn't disappear from the list).
async function loadAvailableDoctorsDropdown(prefix, includeId) {
  const sel = document.getElementById(`${prefix}StaffDoctorId`);
  if (!sel) return;
  sel.innerHTML = `<option value="">Loading doctors…</option>`;
  try {
    const qs = includeId ? `?includeId=${encodeURIComponent(includeId)}` : '';
    const res = await apiGet(`/staff/available-doctors${qs}`);
    const doctors = res.data || [];
    AVAILABLE_DOCTORS_CACHE[prefix] = {};
    doctors.forEach(d => { AVAILABLE_DOCTORS_CACHE[prefix][d._id] = d; });

    if (!doctors.length) {
      sel.innerHTML = `<option value="">No available doctors — add one in the Doctors module first</option>`;
      return;
    }

    sel.innerHTML = `<option value="">Select a doctor…</option>` + doctors.map(d =>
      `<option value="${d._id}">${d.fullName} (${d.doctorId}${d.specialization ? ' · ' + d.specialization : ''})</option>`
    ).join('');
  } catch (err) {
    console.error('Failed to load available doctors:', err);
    sel.innerHTML = `<option value="">Could not load doctors</option>`;
  }
}

// Auto-fills the (hidden, derived) Full Name from the selected
// doctor's profile — per Phase 12.1, doctor logins never get a
// manually-typed name; it always comes from the Doctor record.
function onStaffDoctorSelect(prefix) {
  const sel = document.getElementById(`${prefix}StaffDoctorId`);
  const doctor = AVAILABLE_DOCTORS_CACHE[prefix]?.[sel.value];
  const nameInput = document.getElementById(`${prefix}StaffFullName`);
  if (nameInput) nameInput.value = doctor ? doctor.fullName : '';
}

function resetNewStaffForm() {
  ['newStaffFullName', 'newStaffUsername', 'newStaffPhone', 'newStaffPassword'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.value = '';
  });
  const roleEl = document.getElementById('newStaffRole');
  if (roleEl) roleEl.value = 'doctor';
  const doctorSel = document.getElementById('newStaffDoctorId');
  if (doctorSel) doctorSel.value = '';
  hideNewStaffError();
  // Default role is 'doctor' — load the dropdown and hide Full Name
  // immediately so the modal never briefly shows the wrong fields.
  onStaffRoleChange('new');
}

function showNewStaffError(msg) {
  const e = document.getElementById('newStaffError');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}
function hideNewStaffError() {
  const e = document.getElementById('newStaffError');
  if (e) { e.textContent = ''; e.style.display = 'none'; }
}

async function submitNewStaff() {
  hideNewStaffError();
  const role     = document.getElementById('newStaffRole').value;
  const username = document.getElementById('newStaffUsername').value.trim();
  const phone    = document.getElementById('newStaffPhone').value.trim();
  const password = document.getElementById('newStaffPassword').value;

  const payload = { role, username, phone, password };

  // Phase 12.1 — doctor logins are identified by the linked Doctor
  // profile, not a typed name. Receptionist logins keep the old
  // manual-name path untouched.
  if (role === 'doctor') {
    const doctorId = document.getElementById('newStaffDoctorId').value;
    if (!doctorId) return showNewStaffError('Please select a doctor to link this login to.');
    payload.doctorId = doctorId;
    payload.fullName = AVAILABLE_DOCTORS_CACHE.new[doctorId]?.fullName || document.getElementById('newStaffFullName').value.trim();
  } else {
    payload.fullName = document.getElementById('newStaffFullName').value.trim();
    if (!payload.fullName) return showNewStaffError('Full name is required.');
  }

  if (!username) return showNewStaffError('Username is required.');
  if (!phone)    return showNewStaffError('Phone number is required.');
  if (!password || password.length < 8) return showNewStaffError('Password must be at least 8 characters long.');

  const btn = document.getElementById('newStaffSubmitBtn');
  btn.disabled = true;
  try {
    await apiPost('/staff', payload);
    showToast('Staff member added successfully!');
    closeModal('addStaffModal');
    loadStaff();
  } catch (err) {
    console.error('Failed to add staff member:', err);
    showNewStaffError(err.message || 'Could not add staff member. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}

function openEditStaffModal(id) {
  const s = STAFF.find(x => x._id === id);
  if (!s) return showToast('Could not find that staff member', 'error');
  document.getElementById('editStaffId').value      = s._id;
  document.getElementById('editStaffCurrentDoctorId').value = s.doctorId || '';
  document.getElementById('editStaffFullName').value = s.fullName || '';
  document.getElementById('editStaffUsername').value = s.username || '';
  document.getElementById('editStaffPhone').value    = s.phone || '';
  document.getElementById('editStaffRole').value     = s.role;
  hideEditStaffError();

  // Phase 12.1 — role is locked on edit (see settings.html), so this
  // only sets up the initial doctor-vs-name field visibility; it never
  // re-fires from a role change here. includeId keeps this staff
  // member's own currently-linked doctor selectable in the dropdown.
  const doctorGroup = document.getElementById('editStaffDoctorGroup');
  const nameGroup = document.getElementById('editStaffFullNameGroup');
  if (s.role === 'doctor') {
    nameGroup.style.display = 'none';
    doctorGroup.style.display = 'block';
    loadAvailableDoctorsDropdown('edit', s.doctorId).then(() => {
      const sel = document.getElementById('editStaffDoctorId');
      if (sel && s.doctorId) sel.value = s.doctorId;
    });
  } else {
    nameGroup.style.display = 'block';
    doctorGroup.style.display = 'none';
  }

  openModal('editStaffModal');
}

function showEditStaffError(msg) {
  const e = document.getElementById('editStaffError');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}
function hideEditStaffError() {
  const e = document.getElementById('editStaffError');
  if (e) { e.textContent = ''; e.style.display = 'none'; }
}

async function submitEditStaff() {
  hideEditStaffError();
  const id       = document.getElementById('editStaffId').value;
  const role     = document.getElementById('editStaffRole').value;
  const username = document.getElementById('editStaffUsername').value.trim();
  const phone    = document.getElementById('editStaffPhone').value.trim();

  const payload = { username, phone };

  // Phase 12.1 — doctor logins: fullName is never sent from here (it
  // stays derived from the linked Doctor profile server-side); only
  // doctorId is sent, and only when it's genuinely being changed —
  // relinking to a different doctor. Sending the unchanged value is
  // harmless (server treats it as a no-op, not a relink) but we skip
  // it anyway to keep intent clear in the request.
  if (role === 'doctor') {
    const doctorId = document.getElementById('editStaffDoctorId').value;
    const currentDoctorId = document.getElementById('editStaffCurrentDoctorId').value;
    if (!doctorId) return showEditStaffError('Please select a doctor to link this login to.');
    if (doctorId !== currentDoctorId) payload.doctorId = doctorId;
  } else {
    payload.fullName = document.getElementById('editStaffFullName').value.trim();
    if (!payload.fullName) return showEditStaffError('Full name is required.');
  }

  if (!username) return showEditStaffError('Username is required.');
  if (!phone)    return showEditStaffError('Phone number is required.');

  const btn = document.getElementById('editStaffSubmitBtn');
  btn.disabled = true;
  try {
    await apiPut(`/staff/${id}`, payload);
    showToast('Staff member updated successfully!');
    closeModal('editStaffModal');
    loadStaff();
  } catch (err) {
    console.error('Failed to update staff member:', err);
    showEditStaffError(err.message || 'Could not update staff member. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}

async function toggleStaffStatus(id, makeActive) {
  try {
    await apiPatch(`/staff/${id}/status`, { isActive: makeActive });
    showToast(makeActive ? 'Staff member activated' : 'Staff member deactivated');
    loadStaff();
  } catch (err) {
    console.error('Failed to update staff status:', err);
    showToast('Could not update staff status', 'error');
  }
}

function openResetStaffPasswordModal(id) {
  const s = STAFF.find(x => x._id === id);
  if (!s) return showToast('Could not find that staff member', 'error');
  document.getElementById('resetStaffId').value       = s._id;
  document.getElementById('resetStaffName').textContent = `Set a new password for ${s.fullName} (@${s.username || '—'}).`;
  document.getElementById('resetStaffNewPassword').value = '';
  hideResetStaffError();
  openModal('resetStaffPasswordModal');
}

function showResetStaffError(msg) {
  const e = document.getElementById('resetStaffError');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}
function hideResetStaffError() {
  const e = document.getElementById('resetStaffError');
  if (e) { e.textContent = ''; e.style.display = 'none'; }
}

async function submitResetStaffPassword() {
  hideResetStaffError();
  const id          = document.getElementById('resetStaffId').value;
  const newPassword = document.getElementById('resetStaffNewPassword').value;

  if (!newPassword || newPassword.length < 8) return showResetStaffError('Password must be at least 8 characters long.');

  const btn = document.getElementById('resetStaffSubmitBtn');
  btn.disabled = true;
  try {
    await apiPatch(`/staff/${id}/reset-password`, { newPassword });
    showToast('Password reset successfully!');
    closeModal('resetStaffPasswordModal');
  } catch (err) {
    console.error('Failed to reset staff password:', err);
    showResetStaffError(err.message || 'Could not reset password. Please try again.');
  } finally {
    btn.disabled = false;
  }
}
/* ============================================================
   DEPARTMENT MANAGEMENT (Phase 12.5)
   GET/POST    /api/departments
   GET/PUT     /api/departments/:id
   PATCH       /api/departments/:id/status
   PATCH       /api/departments/reorder
   clinic_admin: full access. receptionist/doctor/billing_staff: read
   only (server.js authorize() enforces this; the UI here is only
   ever loaded for whoever can reach Settings in the first place).
   MongoDB is the only source of truth — no hardcoded department
   arrays anywhere in this module. Zero departments renders
   "No departments found", never fake/sample rows.
   ============================================================ */

let DEPARTMENTS = [];
let deptSearchDebounce = null;

async function loadDepartments() {
  const el = document.getElementById('departmentList');
  if (el) el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Loading departments…</div>`;
  try {
    const search = document.getElementById('deptSearch')?.value || '';
    const isActive = document.getElementById('deptStatusFilter')?.value || '';
    const params = new URLSearchParams({ limit: '200', sortBy: 'displayOrder', sortOrder: 'asc' });
    if (search) params.set('search', search);
    if (isActive) params.set('isActive', isActive);
    const res = await apiGet(`/departments?${params}`);
    DEPARTMENTS = res.data || [];
    renderDepartmentList(DEPARTMENTS);
  } catch (err) {
    console.error('Failed to load departments:', err);
    if (el) el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Could not load departments</div>`;
    showToast('Could not load departments', 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('deptSearch')?.addEventListener('input', () => {
    clearTimeout(deptSearchDebounce);
    deptSearchDebounce = setTimeout(loadDepartments, 300);
  });
  document.getElementById('deptStatusFilter')?.addEventListener('change', loadDepartments);
  document.querySelectorAll('[onclick*="openModal(\'addDepartmentModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetNewDeptForm);
  });
});

function renderDepartmentList(data) {
  const el = document.getElementById('departmentList');
  if (!el) return;
  if (!data.length) {
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">No departments found</div>`;
    return;
  }
  // Reorder (up/down) only makes sense against the clinic's full,
  // unfiltered display-order sequence — disable it while a search or
  // status filter is active so a filtered view can't scramble order.
  const filtering = !!(document.getElementById('deptSearch')?.value || document.getElementById('deptStatusFilter')?.value);

  el.innerHTML = data.map((d, i) => `
    <div class="staff-item">
      <div style="width:14px;height:14px;border-radius:50%;flex-shrink:0;background:${d.color || 'var(--color-secondary-light)'}"></div>
      <div class="staff-item-info">
        <div class="staff-item-name">${d.name}</div>
        <div class="staff-item-meta">${d.departmentId}${d.description ? ' · ' + d.description : ''}</div>
      </div>
      <span class="badge-status badge-${d.isActive ? 'active' : 'inactive'}">${d.isActive ? 'Active' : 'Inactive'}</span>
      <div class="staff-actions">
        ${can('departments', 'edit') ? `<button class="tbl-action-btn" title="Move up" ${filtering || i === 0 ? 'disabled' : ''} onclick="moveDepartment('${d._id}', -1)"><span class="material-symbols-outlined">arrow_upward</span></button>` : ''}
        ${can('departments', 'edit') ? `<button class="tbl-action-btn" title="Move down" ${filtering || i === data.length - 1 ? 'disabled' : ''} onclick="moveDepartment('${d._id}', 1)"><span class="material-symbols-outlined">arrow_downward</span></button>` : ''}
        ${can('departments', 'edit') ? `<button class="tbl-action-btn" title="Edit" onclick="openEditDeptModal('${d._id}')"><span class="material-symbols-outlined">edit</span></button>` : ''}
        ${can('departments', 'delete') ? `<button class="tbl-action-btn" title="${d.isActive ? 'Deactivate' : 'Activate'}" onclick="toggleDeptStatus('${d._id}', ${!d.isActive})"><span class="material-symbols-outlined">${d.isActive ? 'block' : 'check_circle'}</span></button>` : ''}
      </div>
    </div>
  `).join('');
}

/* ---------- Reorder ----------
   Swaps this department with its immediate neighbor in the current
   (unfiltered) DEPARTMENTS order, then sends the full new order to
   PATCH /api/departments/reorder. Simple up/down swap rather than
   drag-and-drop — no new dependency, keeps the existing UI language
   (tbl-action-btn icon buttons) used everywhere else in this app. */
async function moveDepartment(id, direction) {
  const index = DEPARTMENTS.findIndex(d => d._id === id);
  const swapWith = index + direction;
  if (index === -1 || swapWith < 0 || swapWith >= DEPARTMENTS.length) return;

  const reordered = DEPARTMENTS.slice();
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  const order = reordered.map(d => d._id);

  try {
    await apiPatch('/departments/reorder', { order });
    loadDepartments();
  } catch (err) {
    console.error('Failed to reorder departments:', err);
    showToast('Could not reorder departments', 'error');
  }
}

/* ---------- Add Department ---------- */

function resetNewDeptForm() {
  ['newDeptName', 'newDeptDescription'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.value = '';
  });
  document.querySelectorAll('input[name="newDeptColor"]').forEach((r, i) => { r.checked = i === 0; });
  const custom = document.getElementById('newDeptColorCustom');
  if (custom) custom.value = '#1B4D3E';
  hideNewDeptError();
}

function showNewDeptError(msg) {
  const e = document.getElementById('newDeptError');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}
function hideNewDeptError() {
  const e = document.getElementById('newDeptError');
  if (e) { e.textContent = ''; e.style.display = 'none'; }
}

function getCheckedColor(radioName, customInputId) {
  const checked = document.querySelector(`input[name="${radioName}"]:checked`);
  if (checked) return checked.value;
  const custom = document.getElementById(customInputId);
  return custom ? custom.value : undefined;
}

async function submitNewDepartment() {
  hideNewDeptError();
  const name = document.getElementById('newDeptName').value.trim();
  const description = document.getElementById('newDeptDescription').value.trim();
  const color = getCheckedColor('newDeptColor', 'newDeptColorCustom');

  if (!name) return showNewDeptError('Department name is required.');
  if (!/[a-zA-Z0-9]/.test(name)) return showNewDeptError('Department name cannot consist only of special characters.');

  const btn = document.getElementById('newDeptSubmitBtn');
  btn.disabled = true;
  try {
    await apiPost('/departments', { name, description: description || undefined, color: color || undefined });
    showToast('Department added successfully!');
    closeModal('addDepartmentModal');
    loadDepartments();
  } catch (err) {
    console.error('Failed to add department:', err);
    showNewDeptError(err.message || 'Could not add department. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Edit Department ---------- */

function openEditDeptModal(id) {
  const d = DEPARTMENTS.find(x => x._id === id);
  if (!d) return showToast('Could not find that department', 'error');
  document.getElementById('editDeptId').value = d._id;
  document.getElementById('editDeptName').value = d.name || '';
  document.getElementById('editDeptDescription').value = d.description || '';
  const color = d.color || '#1B4D3E';
  let matched = false;
  document.querySelectorAll('input[name="editDeptColor"]').forEach(r => {
    r.checked = r.value.toLowerCase() === color.toLowerCase();
    if (r.checked) matched = true;
  });
  const custom = document.getElementById('editDeptColorCustom');
  if (custom) custom.value = matched ? '#1B4D3E' : color;
  hideEditDeptError();
  openModal('editDepartmentModal');
}

function showEditDeptError(msg) {
  const e = document.getElementById('editDeptError');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}
function hideEditDeptError() {
  const e = document.getElementById('editDeptError');
  if (e) { e.textContent = ''; e.style.display = 'none'; }
}

async function submitEditDepartment() {
  hideEditDeptError();
  const id = document.getElementById('editDeptId').value;
  const name = document.getElementById('editDeptName').value.trim();
  const description = document.getElementById('editDeptDescription').value.trim();
  const color = getCheckedColor('editDeptColor', 'editDeptColorCustom');

  if (!name) return showEditDeptError('Department name is required.');
  if (!/[a-zA-Z0-9]/.test(name)) return showEditDeptError('Department name cannot consist only of special characters.');

  const btn = document.getElementById('editDeptSubmitBtn');
  btn.disabled = true;
  try {
    await apiPut(`/departments/${id}`, { name, description, color: color || '' });
    showToast('Department updated successfully!');
    closeModal('editDepartmentModal');
    loadDepartments();
  } catch (err) {
    console.error('Failed to update department:', err);
    showEditDeptError(err.message || 'Could not update department. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Activate / Deactivate ---------- */

async function toggleDeptStatus(id, makeActive) {
  try {
    await apiPatch(`/departments/${id}/status`, { isActive: makeActive });
    showToast(makeActive ? 'Department activated' : 'Department deactivated');
    loadDepartments();
  } catch (err) {
    console.error('Failed to update department status:', err);
    showToast('Could not update department status', 'error');
  }
}

/* ============================================================
   ROLE PERMISSIONS MATRIX (Phase 13.0)
   GET    /api/permissions        — any authenticated clinic user
   PUT    /api/permissions        — clinic_admin only
   POST   /api/permissions/reset  — clinic_admin only

   Fully database-driven: no permission values are hardcoded here.
   PERMISSION_ROLES / MODULES / ACTIONS below only describe *shape*
   (labels, table columns, tab order) — every checkbox's checked
   state always comes from the server response.
   ============================================================ */

// Mirrors server.js PERMISSION_ROLES / PERMISSION_MODULES / PERMISSION_ACTIONS.
// Adding/removing a role, module, or action still requires a matching
// server-side change — this is display metadata, not the source of truth.
// Phase 13.1 added 'staff' and 'departments' as their own enforcement
// modules (see server.js buildDefaultMatrix comment) since neither
// fits the access pattern of the original 8 Phase 13.0 modules.
//
// Phase 13.2 — PERMISSION_MODULES and PERMISSION_ACTIONS now live in
// permissions.js (loaded before this file on every page) since the
// frontend permission engine needs the exact same lists; declaring
// them twice would throw a duplicate-const error. PERMISSION_ROLES
// has no equivalent in permissions.js (the frontend only ever cares
// about the CURRENT user's single role, never the full role list) so
// it stays here.
const PERMISSION_ROLES = ['clinic_admin', 'doctor', 'receptionist', 'billing_staff'];
const PERMISSION_ROLE_LABELS = {
  clinic_admin: 'Clinic Admin',
  doctor: 'Doctor',
  receptionist: 'Receptionist',
  billing_staff: 'Billing Staff',
};
const PERMISSION_MODULE_LABELS = {
  dashboard: 'Dashboard',
  appointments: 'Appointments',
  patients: 'Patients',
  doctors: 'Doctors',
  calendar: 'Calendar',
  billing: 'Billing',
  reports: 'Reports',
  settings: 'Settings',
  staff: 'Staff Management',
  departments: 'Department Management',
};

let PERMISSIONS_MATRIX = null;   // last-loaded-from-server matrix (source of truth on reload)
let permActiveRole = 'clinic_admin';
let permCanEdit = false;         // true only if logged-in user's role is clinic_admin

/* ---------- Load ----------
   Phase 13.2 — renamed from loadPermissions() to
   loadPermissionMatrixEditor() to avoid colliding with permissions.js's
   loadPermissions() (the frontend permission engine's own loader,
   which fetches the same /api/permissions endpoint but for a
   different purpose: gating THIS user's UI, not editing the matrix). */
async function loadPermissionMatrixEditor() {
  try {
    const res = await apiGet('/permissions');
    PERMISSIONS_MATRIX = res.data.matrix || {};
    await determinePermissionEditAccess();
    renderPermissionRoleTabs();
    renderPermissionMatrix();
  } catch (err) {
    console.error('Failed to load permissions:', err);
    const tbody = document.getElementById('permMatrixBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-sm" style="text-align:left;padding:12px 4px">Could not load permissions.</td></tr>`;
    }
    showToast('Could not load role permissions', 'error');
  }
}

// window._appUser.role (set by global.js loadAppMeta) is a display-
// formatted string ("Clinic Admin"), and may not be populated yet by
// the time this runs since loadAppMeta() resolves asynchronously.
// Fall back to a direct /auth/me call so the edit-lock decision never
// races the shared layout script.
async function determinePermissionEditAccess() {
  let rawRole = null;
  if (window._appUser?.role) {
    rawRole = window._appUser.role.toLowerCase().replace(/\s+/g, '_');
  } else {
    try {
      const me = await apiGet('/auth/me');
      const u = me.data || me.user || me;
      rawRole = u.role || null;
    } catch (err) {
      console.warn('Could not resolve current user role for permission editing:', err);
    }
  }
  permCanEdit = rawRole === 'clinic_admin';
}

/* ---------- Role tabs ---------- */

function renderPermissionRoleTabs() {
  const wrap = document.getElementById('permRoleTabs');
  if (!wrap) return;

  if (!PERMISSION_ROLES.includes(permActiveRole)) permActiveRole = PERMISSION_ROLES[0];

  wrap.innerHTML = PERMISSION_ROLES.map(role => `
    <div class="perm-role-tab ${role === permActiveRole ? 'active' : ''}" data-role="${role}">
      ${escapeHtml(PERMISSION_ROLE_LABELS[role] || role)}
    </div>
  `).join('');

  wrap.querySelectorAll('.perm-role-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      permActiveRole = tab.dataset.role;
      renderPermissionRoleTabs();
      renderPermissionMatrix();
    });
  });
}

/* ---------- Matrix table ---------- */

function renderPermissionMatrix() {
  const tbody = document.getElementById('permMatrixBody');
  const lockedNote = document.getElementById('permLockedNote');
  if (!tbody) return;

  if (lockedNote) lockedNote.style.display = permCanEdit ? 'none' : 'flex';
  const saveBtn = document.getElementById('permSaveBtn');
  const resetBtn = document.getElementById('permResetBtn');
  if (saveBtn) saveBtn.disabled = !permCanEdit;
  if (resetBtn) resetBtn.disabled = !permCanEdit;

  const roleMatrix = PERMISSIONS_MATRIX?.[permActiveRole] || {};

  tbody.innerHTML = PERMISSION_MODULES.map(mod => {
    const moduleVal = roleMatrix[mod] || {};
    const cells = PERMISSION_ACTIONS.map(action => {
      const checked = Boolean(moduleVal[action]);
      const disabled = !permCanEdit;
      return `<td>
        <input type="checkbox"
               data-role="${permActiveRole}" data-module="${mod}" data-action="${action}"
               ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      </td>`;
    }).join('');
    return `<tr><td>${escapeHtml(PERMISSION_MODULE_LABELS[mod] || mod)}</td>${cells}</tr>`;
  }).join('');

  // Checkbox edits mutate PERMISSIONS_MATRIX in memory only; nothing
  // reaches the server until Save Permissions is clicked.
  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const { role, module, action } = cb.dataset;
      if (!PERMISSIONS_MATRIX[role]) PERMISSIONS_MATRIX[role] = {};
      if (!PERMISSIONS_MATRIX[role][module]) PERMISSIONS_MATRIX[role][module] = {};
      PERMISSIONS_MATRIX[role][module][action] = cb.checked;
    });
  });
}

/* ---------- Save ---------- */

async function savePermissionMatrix() {
  if (!permCanEdit) {
    showToast('Only clinic admins can change role permissions', 'error');
    return;
  }
  const btn = document.getElementById('permSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await apiPut('/permissions', { matrix: PERMISSIONS_MATRIX });
    PERMISSIONS_MATRIX = res.data.matrix || PERMISSIONS_MATRIX;
    renderPermissionMatrix();
    showToast('Role permissions saved!');
  } catch (err) {
    console.error('Failed to save permissions:', err);
    showToast(err.message || 'Could not save role permissions', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Reset ---------- */

function initPermissionMatrixControls() {
  document.getElementById('permSaveBtn')?.addEventListener('click', savePermissionMatrix);
  document.getElementById('permResetBtn')?.addEventListener('click', () => {
    if (!permCanEdit) {
      showToast('Only clinic admins can reset role permissions', 'error');
      return;
    }
    openModal('resetPermissionsModal');
  });
}

async function submitResetPermissions() {
  const btn = document.getElementById('permResetConfirmBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await apiPost('/permissions/reset', {});
    PERMISSIONS_MATRIX = res.data.matrix || {};
    closeModal('resetPermissionsModal');
    renderPermissionMatrix();
    showToast('Permissions reset to defaults!');
  } catch (err) {
    console.error('Failed to reset permissions:', err);
    showToast(err.message || 'Could not reset role permissions', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Shared helper ---------- */
// Minimal HTML-escaping for role/module labels rendered via innerHTML.
// All label strings above are static constants, but this stays cheap
// insurance if labels are ever sourced dynamically later.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}