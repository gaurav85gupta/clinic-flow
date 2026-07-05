/* ============================================================
   js/export-helpers.js — Phase 12.2 Module Exports
   Shared front-end glue between each page's Export button and the
   existing Export Core (electron/export/*.js via preload.js's
   window.medicore.export.toPdf / toExcel / toCsv).

   This file adds NO new export logic. It only:
     1. Renders a small, reusable format/scope dialog
     2. Collects { headers, rows } from a module-supplied callback
     3. Calls window.medicore.export.to<Format>(...)
     4. Shows a toast with the result

   Every page's <module>.js calls:
     initExportButton({
       buttonSelector: '...',
       title: 'Patients',
       getFilenameBase: () => 'Patients',
       supportsDateRange: false,
       supportsScope: true,           // "All" vs "Current Page"
       hasCurrentPageData: () => PATIENTS.length > 0,
       buildRows: async (scope, dateRange) => ({ headers, rows, sheetName })
     });
   ============================================================ */

'use strict';

/**
 * True only inside the Electron shell, where preload.js has exposed
 * window.medicore.export. In a plain browser tab (e.g. someone opens
 * these .html files directly) the Export button still degrades
 * gracefully with an explanatory toast rather than throwing.
 */
function exportCoreAvailable() {
  return typeof window !== 'undefined' && window.medicore && window.medicore.export;
}

function _escId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Builds (once) the shared export dialog markup and appends it to
 * <body>. Re-used by every call — only its content is rewritten per
 * invocation so we don't accumulate duplicate modals across modules.
 */
function _ensureExportDialog() {
  if (document.getElementById('exportDialogModal')) return;
  const html = `
    <div class="modal-overlay" id="exportDialogModal">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <div class="modal-title" id="exportDialogTitle">Export</div>
          <button class="modal-close" onclick="closeModal('exportDialogModal')"><span class="material-symbols-outlined">close</span></button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Format</label>
            <div class="form-row" id="exportFormatRow" style="gap:8px">
              <button type="button" class="btn btn-secondary export-fmt-btn" data-fmt="pdf" style="flex:1">PDF</button>
              <button type="button" class="btn btn-secondary export-fmt-btn" data-fmt="xlsx" style="flex:1">Excel</button>
              <button type="button" class="btn btn-secondary export-fmt-btn" data-fmt="csv" style="flex:1">CSV</button>
            </div>
          </div>
          <div class="form-group" id="exportScopeGroup" style="display:none">
            <label class="form-label">Rows</label>
            <select class="form-select" id="exportScopeSelect">
              <option value="all">Export All</option>
              <option value="page">Current Page Only</option>
            </select>
          </div>
          <div class="form-group" id="exportDateRangeGroup" style="display:none">
            <label class="form-label">Date Range</label>
            <div class="form-row">
              <input class="form-input" type="date" id="exportDateFrom">
              <input class="form-input" type="date" id="exportDateTo">
            </div>
          </div>
          <div id="exportDialogError" class="text-sm" style="color:var(--color-error);display:none;margin-top:4px"></div>
          <div id="exportDialogProgress" class="text-muted text-sm" style="display:none;margin-top:8px">Preparing export…</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('exportDialogModal')">Cancel</button>
          <button class="btn btn-primary" id="exportDialogGoBtn"><span class="material-symbols-outlined">download</span> Export</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
}

let _currentExportConfig = null;
let _currentExportFormat = 'pdf';

/**
 * Wires up an Export button (or several matching a selector) to open
 * the shared export dialog, pre-configured for this module.
 *
 * @param {object} cfg
 * @param {string} cfg.buttonSelector - CSS selector for the Export button(s)
 * @param {string} cfg.title - Dialog title / PDF report title, e.g. "Patients"
 * @param {() => string} cfg.getFilenameBase - returns a filename stem, e.g. "Patients_2026-07-02"
 * @param {boolean} [cfg.supportsScope] - show All vs Current Page toggle
 * @param {() => boolean} [cfg.hasCurrentPageData] - whether "Current Page" is meaningful right now
 * @param {boolean} [cfg.supportsDateRange] - show a date-range picker
 * @param {(scope: 'all'|'page', dateRange: {from?:string,to?:string}) => Promise<{headers:string[], rows:any[][], sheetName?:string}>} cfg.buildRows
 */
function initExportButton(cfg) {
  _ensureExportDialog();
  const buttons = document.querySelectorAll(cfg.buttonSelector);
  if (!buttons.length) return;

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => openExportDialog(cfg));
  });
}

function openExportDialog(cfg) {
  _currentExportConfig = cfg;
  _currentExportFormat = 'pdf';

  document.getElementById('exportDialogTitle').textContent = `Export ${cfg.title}`;
  document.getElementById('exportDialogError').style.display = 'none';
  document.getElementById('exportDialogProgress').style.display = 'none';

  // Format buttons
  document.querySelectorAll('.export-fmt-btn').forEach((b) => {
    b.classList.toggle('btn-primary', b.dataset.fmt === 'pdf');
    b.classList.toggle('btn-secondary', b.dataset.fmt !== 'pdf');
    b.onclick = () => {
      _currentExportFormat = b.dataset.fmt;
      document.querySelectorAll('.export-fmt-btn').forEach((x) => {
        x.classList.toggle('btn-primary', x === b);
        x.classList.toggle('btn-secondary', x !== b);
      });
    };
  });

  // Scope (All vs Current Page)
  const scopeGroup = document.getElementById('exportScopeGroup');
  const scopeSelect = document.getElementById('exportScopeSelect');
  if (cfg.supportsScope) {
    scopeGroup.style.display = '';
    const pageAvailable = cfg.hasCurrentPageData ? !!cfg.hasCurrentPageData() : true;
    scopeSelect.innerHTML = pageAvailable
      ? '<option value="all">Export All</option><option value="page">Current Page Only</option>'
      : '<option value="all">Export All</option>';
    scopeSelect.value = 'all';
  } else {
    scopeGroup.style.display = 'none';
  }

  // Date range
  const dateGroup = document.getElementById('exportDateRangeGroup');
  dateGroup.style.display = cfg.supportsDateRange ? '' : 'none';
  if (cfg.supportsDateRange) {
    document.getElementById('exportDateFrom').value = '';
    document.getElementById('exportDateTo').value = '';
  }

  const goBtn = document.getElementById('exportDialogGoBtn');
  goBtn.disabled = false;
  goBtn.onclick = runCurrentExport;

  openModal('exportDialogModal');
}

async function runCurrentExport() {
  const cfg = _currentExportConfig;
  if (!cfg) return;

  const errEl = document.getElementById('exportDialogError');
  const progEl = document.getElementById('exportDialogProgress');
  const goBtn = document.getElementById('exportDialogGoBtn');
  errEl.style.display = 'none';

  if (!exportCoreAvailable()) {
    errEl.textContent = 'Export is only available in the MediCore desktop app.';
    errEl.style.display = 'block';
    return;
  }

  const scope = cfg.supportsScope ? (document.getElementById('exportScopeSelect').value || 'all') : 'all';
  const dateRange = cfg.supportsDateRange
    ? {
        from: document.getElementById('exportDateFrom').value || undefined,
        to: document.getElementById('exportDateTo').value || undefined,
      }
    : {};

  goBtn.disabled = true;
  progEl.textContent = 'Gathering data…';
  progEl.style.display = 'block';

  try {
    const { headers, rows, sheetName } = await cfg.buildRows(scope, dateRange);

    if (!rows || !rows.length) {
      errEl.textContent = 'There is no data to export for the selected options.';
      errEl.style.display = 'block';
      progEl.style.display = 'none';
      goBtn.disabled = false;
      return;
    }

    progEl.textContent = `Generating ${_currentExportFormat.toUpperCase()}…`;

    const filenameBase = cfg.getFilenameBase ? cfg.getFilenameBase() : cfg.title;
    const clinicName = window._appClinicName || 'MediCore Clinic';
    const generatedBy = window._appUser?.fullName || 'MediCore';

    let result;
    if (_currentExportFormat === 'pdf') {
      result = await window.medicore.export.toPdf({
        filename: filenameBase,
        clinicName,
        title: cfg.title,
        generatedBy,
        headers,
        rows,
        orientation: headers.length > 6 ? 'landscape' : 'portrait',
      });
    } else if (_currentExportFormat === 'xlsx') {
      result = await window.medicore.export.toExcel({
        filename: filenameBase,
        sheetName: sheetName || cfg.title,
        headers,
        rows,
      });
    } else {
      result = await window.medicore.export.toCsv({
        filename: filenameBase,
        headers,
        rows,
      });
    }

    progEl.style.display = 'none';
    goBtn.disabled = false;

    if (result && result.success) {
      closeModal('exportDialogModal');
      showToast(`Exported to ${result.filePath}`);
    } else if (result && result.canceled) {
      // User dismissed the native Save dialog — no error, just stay open.
    } else {
      errEl.textContent = (result && result.error) || 'Export failed. Please try again.';
      errEl.style.display = 'block';
    }
  } catch (err) {
    console.error('Export failed:', err);
    progEl.style.display = 'none';
    goBtn.disabled = false;
    errEl.textContent = err.message || 'Export failed. Please try again.';
    errEl.style.display = 'block';
  }
}

/* ---------- shared formatting helpers for module buildRows() ---------- */

function exportFmtDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

function exportFmtDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pages through a paginated GET list endpoint until every matching
 * record has been fetched, respecting the server's own per-page cap
 * (patients/doctors max 100, appointments/billing max 200) rather
 * than trying to request one giant page. Used for "Export All".
 *
 * @param {string} endpoint - e.g. '/patients?isActive=true'
 * @param {number} [pageSize]
 * @returns {Promise<any[]>}
 */
async function exportFetchAllPages(endpoint, pageSize = 200) {
  const all = [];
  let page = 1;
  const sep = endpoint.includes('?') ? '&' : '?';
  // Safety cap: never loop more than 200 pages (40,000+ records at
  // pageSize 200) so a server bug can't hang the export indefinitely.
  for (let i = 0; i < 200; i++) {
    const res = await apiGet(`${endpoint}${sep}page=${page}&limit=${pageSize}`);
    const batch = res.data || [];
    all.push(...batch);
    const pagination = res.pagination;
    if (!pagination || page >= (pagination.pages || 1) || batch.length === 0) break;
    page += 1;
  }
  return all;
}
