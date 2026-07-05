/* BILLING JS — Phase: Hardcoded Data Removal Audit
   Data sources:
     GET /api/billing/summary       — KPI strip (today/month/overdue) + top doctors (used for Top Services substitute)
     GET /api/invoices              — invoice table
     GET /api/invoices/:id          — invoice detail modal
     GET /api/reports/revenue       — 6-month revenue trend for the chart, revenue by department
     GET /api/reports/payments      — payment-method mix
   No mock arrays. MongoDB via api.js is the single source of truth. */

let INVOICES = [];
let billingChartInstance = null;


document.addEventListener('DOMContentLoaded', () => {
  initLayout('billing');
  // Phase 13.2 — nothing below runs if the user lacks billing.view.
  window._appPageGuardReady.then(allowed => {
    if (!allowed) return;
    loadBillingSummary();
    loadInvoices();
    loadRevenueChart();
    loadPaymentMethods();
    loadTopDepartments();
    document.getElementById('billingMonthFilter')?.addEventListener('change', loadInvoices);
    applyBillingPagePermissions();
    // initBillingExport() binds its click handler directly to the
    // page-header Export button by selector — must run AFTER the
    // permission check below (which may remove that same button), or
    // skip entirely if the role has no export rights.
    if (can('billing', 'export')) initBillingExport();
  });
});

/* ============================================================
   PAGE-LEVEL BUTTON PERMISSIONS (Phase 13.2)
   ============================================================ */
function applyBillingPagePermissions() {
  if (!can('billing', 'create')) {
    document.querySelector('[onclick="openModal(\'createInvoiceModal\')"]')?.remove();
  }
  if (!can('billing', 'export')) {
    document.querySelectorAll('.page-header-actions .btn-secondary').forEach(btn => {
      if (btn.textContent.includes('Export')) btn.remove();
    });
  }
}

/* ---------- Export (Phase 12.2) ----------
   Respects the current month filter, same as loadInvoices(). */
function initBillingExport() {
  initExportButton({
    buttonSelector: '.page-header-actions .btn-secondary',
    title: 'Billing',
    getFilenameBase: () => {
      const monthVal = document.getElementById('billingMonthFilter')?.value;
      if (monthVal) {
        const [y, m] = monthVal.split('-').map(Number);
        const label = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).replace(' ', '_');
        return `Billing_Report_${label}`;
      }
      return `Billing_${exportFmtDateStamp()}`;
    },
    supportsScope: true,
    hasCurrentPageData: () => INVOICES.length > 0,
    buildRows: async (scope) => {
      let data;
      if (scope === 'page') {
        data = INVOICES;
      } else {
        const monthVal = document.getElementById('billingMonthFilter')?.value;
        const params = {};
        if (monthVal) {
          const [y, m] = monthVal.split('-').map(Number);
          params.dateFrom = `${monthVal}-01`;
          const lastDay = new Date(y, m, 0).getDate();
          params.dateTo = `${monthVal}-${String(lastDay).padStart(2, '0')}`;
        }
        const qs = new URLSearchParams(params).toString();
        data = await exportFetchAllPages(`/billing${qs ? '?' + qs : ''}`);
      }
      const headers = ['Invoice Number', 'Patient', 'Doctor', 'Amount', 'Tax', 'Discount', 'Total', 'Payment Status', 'Payment Method', 'Invoice Date'];
      const rows = data.map(inv => [
        inv.invoiceNumber || '',
        inv.patientId?.fullName || '',
        inv.doctorId?.fullName || '',
        inv.subtotal != null ? inv.subtotal : '',
        inv.tax != null ? inv.tax : '',
        inv.discount != null ? inv.discount : '',
        inv.total != null ? inv.total : '',
        inv.isOverdue ? 'overdue' : (inv.paymentStatus || ''),
        inv.paymentMethod || '',
        exportFmtDate(inv.invoiceDate),
      ]);
      return { headers, rows, sheetName: 'Invoices' };
    },
  });
}

async function loadBillingSummary() {
  try {
    const res = await apiGet('/billing/summary');
    const d = res.data;
    setText('kpiTodayCollection', formatCurrency(d.today.collected));
    setText('kpiMonthlyRevenue', formatCurrency(d.month.collected));
    setText('kpiPendingInvoices', formatCurrency(d.statusBreakdown.pending?.amount || 0));
    setText('kpiPendingCount', `${d.statusBreakdown.pending?.count || 0} invoices pending`);
    setText('kpiOverdueAmount', formatCurrency(d.overdue.amount));
    setText('kpiOverdueCount', `${d.overdue.count} invoices overdue`);
  } catch (err) {
    console.error('Failed to load billing summary:', err);
    showToast('Could not load billing summary', 'error');
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function loadInvoices() {
  const tbody = document.getElementById('invoiceTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-sm" style="padding:16px">Loading invoices…</td></tr>`;
  try {
    const monthVal = document.getElementById('billingMonthFilter')?.value; // "YYYY-MM"
    const params = {};
    if (monthVal) {
      const [y, m] = monthVal.split('-').map(Number);
      params.dateFrom = `${monthVal}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      params.dateTo = `${monthVal}-${String(lastDay).padStart(2, '0')}`;
    }
    const query = new URLSearchParams(params).toString();
    const res = await apiGet(`/billing${query ? '?' + query : ''}`);
    INVOICES = res.data || [];
    renderInvoices(INVOICES);
    renderInvoicePagination(res.pagination);
  } catch (err) {
    console.error('Failed to load invoices:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-sm" style="padding:16px">Could not load invoices</td></tr>`;
    showToast('Could not load invoices', 'error');
  }
}

function renderInvoicePagination(pagination) {
  const el = document.querySelector('.pagination span');
  if (el && pagination) {
    const start = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.page * pagination.limit, pagination.total);
    el.textContent = `Showing ${start}–${end} of ${pagination.total.toLocaleString('en-US')} invoices`;
  }
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

function renderInvoices(data) {
  const tbody = document.getElementById('invoiceTableBody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-sm" style="padding:16px">No invoices found</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(inv => {
    const patient = inv.patientId || {};
    const doctor = inv.doctorId || {};
    const status = inv.isOverdue ? 'overdue' : inv.paymentStatus;
    const services = (inv.items || []).map(i => i.description).join(', ');
    return `
    <tr>
      <td><div class="td-primary" style="font-family:'Manrope',sans-serif">${inv.invoiceNumber}</div></td>
      <td>
        <div class="flex items-center gap-sm">
          <div class="table-avatar ${doctor.avatarColor || 'av-1'}">${initialsFromName(patient.fullName)}</div>
          <div class="td-primary">${patient.fullName || 'Unknown'}</div>
        </div>
      </td>
      <td><div class="td-muted">${doctor.fullName || '—'}</div></td>
      <td><div class="td-muted" style="font-size:11px">${services || '—'}</div></td>
      <td><div class="td-primary font-bold">${formatCurrency(inv.total)}</div></td>
      <td><div class="td-muted">${fmtDate(inv.invoiceDate)}</div></td>
      <td><span class="badge-status badge-${status}">${status}</span></td>
      <td>
        <div class="action-btn-group">
          ${canView('billing') ? `<button class="tbl-action-btn" onclick="showInvoice('${inv._id}')" title="View"><span class="material-symbols-outlined">visibility</span></button>` : ''}
          ${canView('billing') ? `<button class="tbl-action-btn" title="Print"><span class="material-symbols-outlined">print</span></button>` : ''}
          ${inv.paymentStatus !== 'paid' && can('billing', 'manage') ? `<button class="tbl-action-btn" title="Mark Paid" onclick="markPaid('${inv._id}')"><span class="material-symbols-outlined">check_circle</span></button>` : ''}
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

async function showInvoice(id) {
  document.getElementById('invoiceDetailBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Loading…</div>`;
  openModal('invoiceDetailModal');
  try {
    const res = await apiGet(`/billing/${id}`);
    const inv = res.data;
    const patient = inv.patientId || {};
    const doctor = inv.doctorId || {};
    const status = inv.isOverdue ? 'overdue' : inv.paymentStatus;
    document.getElementById('invoiceDetailBody').innerHTML = `
      <div class="invoice-print">
        <div class="invoice-print-header">
          <div>
            <div style="font-size:20px;font-weight:800;font-family:'Manrope',sans-serif">MediCore Clinic</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:16px;font-weight:800;font-family:'Manrope',sans-serif">${inv.invoiceNumber}</div>
            <div style="opacity:0.8;font-size:12px">${fmtDate(inv.invoiceDate)}</div>
            <span class="badge-status badge-${status}" style="margin-top:6px;display:inline-flex">${status}</span>
          </div>
        </div>
        <div class="form-row" style="margin-bottom:16px">
          <div><div class="form-label">Billed To</div><div class="font-semibold">${patient.fullName || 'Unknown'}</div></div>
          <div><div class="form-label">Doctor</div><div class="font-semibold">${doctor.fullName || '—'}</div></div>
        </div>
        <table class="invoice-line-table">
          <thead><tr><th>Service</th><th>Qty</th><th>Amount</th></tr></thead>
          <tbody>
            ${(inv.items || []).map(i => `<tr><td>${i.description}</td><td>${i.quantity}</td><td>${formatCurrency(i.amount)}</td></tr>`).join('')}
          </tbody>
        </table>
        <div class="divider"></div>
        <div class="invoice-total">Total: ${formatCurrency(inv.total)}</div>
      </div>
    `;
  } catch (err) {
    console.error('Failed to load invoice:', err);
    document.getElementById('invoiceDetailBody').innerHTML = `<div class="text-muted text-sm" style="padding:16px">Could not load invoice</div>`;
  }
}

async function markPaid(id) {
  try {
    await apiPatch(`/billing/${id}/payment`, { paymentStatus: 'paid' });
    showToast('Invoice marked as paid!');
    loadInvoices();
    loadBillingSummary();
  } catch (err) {
    console.error('Failed to update invoice:', err);
    showToast('Could not update invoice', 'error');
  }
}

// Revenue chart: real 6-month trend from GET /api/reports/revenue
// (period=monthly), replacing the hardcoded 6-value array.
async function loadRevenueChart() {
  const ctx = document.getElementById('billingChart')?.getContext('2d');
  if (!ctx) return;
  try {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 5, 1);
    const params = new URLSearchParams({ period: 'monthly', from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    const res = await apiGet(`/reports/revenue?${params.toString()}`);
    const trend = res.data.trend || [];
    const labels = trend.map(t => t.bucket);
    const values = trend.map(t => t.collected);

    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, 'rgba(46,189,133,0.2)');
    gradient.addColorStop(1, 'rgba(46,189,133,0)');
    if (billingChartInstance) billingChartInstance.destroy();
    billingChartInstance = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Revenue', data: values, backgroundColor: gradient, borderColor: '#2EBD85', borderWidth: 2, borderRadius: 6, borderSkipped: false }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(255,255,255,0.95)', titleColor: '#121c2c', bodyColor: '#52647a', borderColor: 'rgba(46,189,133,0.3)', borderWidth: 1, cornerRadius: 10, callbacks: { label: c => formatCurrency(c.parsed.y) } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974' } },
          y: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { family: 'Inter', size: 11 }, color: '#707974', callback: v => v >= 1000 ? formatCurrency(v/1000).replace(/\d+$/, '') + (v/1000).toFixed(0) + 'K' : formatCurrency(v) } },
        },
      },
    });
  } catch (err) {
    console.error('Failed to load revenue chart:', err);
  }
}

// Payment Methods card: real breakdown from GET /api/reports/payments,
// replacing the hardcoded 48/31/21% mock.
async function loadPaymentMethods() {
  const el = document.querySelector('.payment-methods');
  if (!el) return;
  try {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 1, to.getDate());
    const params = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    const res = await apiGet(`/reports/payments?${params.toString()}`);
    const byMethod = res.data.byMethod || [];
    if (!byMethod.length) {
      el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">No paid invoices in this period</div>`;
      return;
    }
    const icons = { card: 'credit_card', bank_transfer: 'account_balance', cash: 'payments', upi: 'qr_code', insurance: 'health_and_safety', unspecified: 'help' };
    el.innerHTML = byMethod.map(m => `
      <div class="pm-item">
        <div class="pm-icon"><span class="material-symbols-outlined icon-filled">${icons[m.method] || 'payments'}</span></div>
        <div class="pm-info"><div class="pm-name">${m.method}</div><div class="pm-pct">${m.share}%</div></div>
        <div class="pm-bar-track"><div style="width:${m.share}%"></div></div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load payment methods:', err);
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Could not load payment methods</div>`;
  }
}

// "Top Departments by Revenue" card: the backend has no per-service
// revenue aggregation (invoice line items are free-text descriptions,
// not a catalog), but it does aggregate revenue by department via
// /api/reports/revenue → byDepartment (itself derived from the
// Department-backed doctor.specialization field — Phase 12.5), which
// is what this card displays. No hardcoded service/department rows.
async function loadTopDepartments() {
  const el = document.querySelector('.service-list');
  if (!el) return;
  try {
    const to = new Date();
    const from = new Date(to.getFullYear(), 0, 1);
    const params = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    const res = await apiGet(`/reports/revenue?${params.toString()}`);
    const byDept = (res.data.byDepartment || []).slice(0, 5);
    if (!byDept.length) {
      el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">No revenue data yet</div>`;
      return;
    }
    el.innerHTML = byDept.map(d => `
      <div class="service-item"><span>${d.specialization}</span><strong>${formatCurrency(d.revenue)}</strong></div>
    `).join('');
  } catch (err) {
    console.error('Failed to load department revenue:', err);
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0">Could not load department revenue</div>`;
  }
}
/* ============================================================
   CREATE INVOICE — real submission flow
   POST /api/billing requires patientId, items[] (with description,
   quantity, price) — see server.js createInvoice. doctorId, dates,
   notes are optional. Tax/totals are always computed server-side.
   ============================================================ */

let _invoiceSearchDebounce = null;

document.addEventListener('DOMContentLoaded', () => {
  initCreateInvoiceModal();
});

function initCreateInvoiceModal() {
  const searchInput = document.getElementById('newInvPatientSearch');
  searchInput?.addEventListener('input', () => {
    document.getElementById('newInvPatientId').value = '';
    clearTimeout(_invoiceSearchDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      document.getElementById('newInvPatientResults').style.display = 'none';
      return;
    }
    _invoiceSearchDebounce = setTimeout(() => runInvoicePatientSearch(q), 250);
  });

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('newInvPatientResults');
    if (wrap && !e.target.closest('#newInvPatientResults') && e.target.id !== 'newInvPatientSearch') {
      wrap.style.display = 'none';
    }
  });

  document.querySelectorAll('[onclick*="openModal(\'createInvoiceModal\')"]').forEach(btn => {
    btn.addEventListener('click', resetNewInvoiceForm);
  });
}

async function runInvoicePatientSearch(q) {
  const resultsEl = document.getElementById('newInvPatientResults');
  try {
    const res = await apiGet(`/patients?search=${encodeURIComponent(q)}&limit=8`);
    const patients = res.data || [];
    resultsEl.innerHTML = patients.length
      ? patients.map(p => `
          <div class="psr-item" onclick="selectInvoicePatient('${p._id}', '${(p.fullName || '').replace(/'/g, "\\'")}')">
            ${p.fullName || 'Unknown'} <span class="text-muted" style="font-size:11px">${p.patientId || ''}</span>
          </div>
        `).join('')
      : `<div class="psr-empty">No matching patients</div>`;
    resultsEl.style.display = 'block';
  } catch (err) {
    console.error('Patient search failed:', err);
    resultsEl.innerHTML = `<div class="psr-empty">Search failed</div>`;
    resultsEl.style.display = 'block';
  }
}

function selectInvoicePatient(id, name) {
  document.getElementById('newInvPatientId').value = id;
  document.getElementById('newInvPatientSearch').value = name;
  document.getElementById('newInvPatientResults').style.display = 'none';
}

async function loadDoctorsForNewInvoice() {
  const select = document.getElementById('newInvDoctorId');
  if (!select) return;
  try {
    const res = await apiGet('/doctors?limit=100');
    const doctors = res.data || [];
    select.innerHTML = '<option value="">No doctor (optional)</option>' +
      doctors.map(d => `<option value="${d._id}">${d.fullName}${d.specialization ? ' — ' + d.specialization : ''}</option>`).join('');
  } catch (err) {
    console.error('Failed to load doctors for invoice form:', err);
    select.innerHTML = '<option value="">Could not load doctors</option>';
  }
}

function addInvoiceServiceLine() {
  const wrap = document.getElementById('newInvServiceLines');
  const line = document.createElement('div');
  line.className = 'service-line';
  line.innerHTML = `
    <input class="form-input inv-svc-desc" placeholder="Service name" style="flex:1">
    <input class="form-input inv-svc-qty" type="number" placeholder="Qty" style="width:70px" value="1" min="1">
    <input class="form-input inv-svc-price" type="number" placeholder="Price" style="width:120px" min="0">
    <button class="btn btn-ghost btn-icon" onclick="removeInvoiceServiceLine(this)"><span class="material-symbols-outlined">remove</span></button>
  `;
  wrap.appendChild(line);
}

function removeInvoiceServiceLine(btn) {
  const wrap = document.getElementById('newInvServiceLines');
  if (wrap.children.length > 1) btn.closest('.service-line').remove();
}

function resetNewInvoiceForm() {
  document.getElementById('newInvPatientSearch').value = '';
  document.getElementById('newInvPatientId').value = '';
  document.getElementById('newInvPatientResults').style.display = 'none';
  document.getElementById('newInvNotes').value = '';
  const wrap = document.getElementById('newInvServiceLines');
  wrap.innerHTML = `
    <div class="service-line">
      <input class="form-input inv-svc-desc" placeholder="Service name" style="flex:1">
      <input class="form-input inv-svc-qty" type="number" placeholder="Qty" style="width:70px" value="1" min="1">
      <input class="form-input inv-svc-price" type="number" placeholder="Price" style="width:120px" min="0">
      <button class="btn btn-ghost btn-icon" onclick="removeInvoiceServiceLine(this)"><span class="material-symbols-outlined">remove</span></button>
    </div>
  `;
  hideNewInvError();
  loadDoctorsForNewInvoice();
}

function showNewInvError(msg) {
  const el = document.getElementById('newInvError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideNewInvError() {
  const el = document.getElementById('newInvError');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function submitNewInvoice() {
  hideNewInvError();
  const patientId = document.getElementById('newInvPatientId').value;
  const doctorId = document.getElementById('newInvDoctorId').value;
  const invoiceDate = document.getElementById('invoiceDateInput').value;
  const dueDate = document.getElementById('invoiceDueDateInput').value;
  const notes = document.getElementById('newInvNotes').value;

  if (!patientId) return showNewInvError('Please select a patient from the search results.');

  const items = Array.from(document.querySelectorAll('#newInvServiceLines .service-line')).map(line => ({
    description: line.querySelector('.inv-svc-desc').value.trim(),
    quantity: Number(line.querySelector('.inv-svc-qty').value) || 0,
    price: Number(line.querySelector('.inv-svc-price').value) || 0,
  })).filter(i => i.description);

  if (!items.length) return showNewInvError('Add at least one service with a name.');
  for (const i of items) {
    if (i.quantity <= 0) return showNewInvError(`"${i.description}" needs a quantity greater than 0.`);
    if (i.price < 0) return showNewInvError(`"${i.description}" has an invalid price.`);
  }

  const payload = {
    patientId,
    doctorId: doctorId || undefined,
    items,
    invoiceDate: invoiceDate || undefined,
    dueDate: dueDate || undefined,
    notes: notes || undefined,
  };

  const btn = document.getElementById('newInvSubmitBtn');
  btn.disabled = true;
  try {
    await apiPost('/billing', payload);
    showToast('Invoice created!');
    closeModal('createInvoiceModal');
    loadInvoices();
    loadBillingSummary();
  } catch (err) {
    console.error('Failed to create invoice:', err);
    showNewInvError(err.message || 'Could not create invoice. Please check the details and try again.');
  } finally {
    btn.disabled = false;
  }
}