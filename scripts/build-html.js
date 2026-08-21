/**
 * build-html.js
 *
 * Generates the standalone app page (public/index.html) with the dataset
 * embedded inline as a <script> tag — no fetch(), no server, opens directly
 * from disk (file://) in any browser. Re-run after build-dataset.js whenever
 * the underlying data changes.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATASET_PATH = path.join(DATA_DIR, 'site-of-service-dataset.json');
const OUT_PATH = path.join(PUBLIC_DIR, 'index.html');

// Starter category -> CPT range map (Musculoskeletal System sub-ranges, plus
// a handful of other major specialty sections). CPT range boundaries are
// structural facts, not copyrighted text — safe to embed. Not exhaustive;
// meant to be extended as real lookups come up. "Custom range" always lets
// you bypass this entirely.
const CATEGORIES = [
  { label: 'Hand and fingers', range: [26010, 26989] },
  { label: 'Forearm and wrist', range: [25000, 25999] },
  { label: 'Shoulder', range: [23000, 23929] },
  { label: 'Humerus and elbow', range: [23930, 24999] },
  { label: 'Pelvis and hip', range: [26990, 27299] },
  { label: 'Femur and knee', range: [27301, 27599] },
  { label: 'Leg (tibia/fibula) and ankle', range: [27600, 27899] },
  { label: 'Foot and toes', range: [28001, 28899] },
  { label: 'Spine', range: [21920, 22999] },
  { label: 'Skin (integumentary)', range: [10004, 19499] },
  { label: 'Digestive system', range: [40490, 49999] },
  { label: 'Cardiovascular system', range: [33016, 37799] },
  { label: 'Eye', range: [65091, 68899] },
  { label: 'Urinary system', range: [50010, 53899] },
  { label: 'Nervous system', range: [61000, 64999] },
  { label: 'Respiratory system', range: [30000, 32999] },
];

const CSS = `
:root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --gridline: #e1e0d9;
  --baseline: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --accent: #2a78d6;
  --row-hover: #f0f4fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --gridline: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255,255,255,0.10);
    --accent: #3987e5;
    --row-hover: #16202c;
  }
}
* { box-sizing: border-box; }
body {
  background: var(--page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0;
  padding: 24px;
  line-height: 1.4;
}
h1 { font-size: 1.3rem; margin: 0 0 4px; }
.subtitle { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 20px; }
.panel {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
.controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 0.75rem; color: var(--text-secondary); font-weight: 600; }
.field input, .field select {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--page);
  color: var(--text-primary);
  font-size: 0.85rem;
  font-family: inherit;
}
.field input[type="number"] { width: 90px; }
.field.grow { flex: 1 1 220px; }
.checkbox-field { flex-direction: row; align-items: center; gap: 6px; }
.checkbox-field label { font-weight: 400; font-size: 0.82rem; color: var(--text-primary); }
button {
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
  background: var(--surface-1);
  color: var(--text-primary);
}
button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.summary-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.result-count { font-size: 0.85rem; color: var(--text-secondary); }
table { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
thead th {
  position: sticky; top: 0; background: var(--surface-1);
  text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--gridline);
  color: var(--text-secondary); font-weight: 600; cursor: pointer; user-select: none;
  white-space: nowrap;
}
thead th:hover { color: var(--accent); }
thead th.group-office { border-left: 3px solid #1baf7a33; }
thead th.group-asc { border-left: 3px solid #2a78d633; }
thead th.group-hopd { border-left: 3px solid #eb683433; }
tbody td { padding: 6px 10px; border-bottom: 1px solid var(--gridline); vertical-align: top; }
tbody tr:hover { background: var(--row-hover); }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.notes { color: var(--text-muted); font-size: 0.75rem; max-width: 280px; }
td.code { font-variant-numeric: tabular-nums; white-space: nowrap; }
.table-wrap { max-height: 70vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.empty-cell { color: var(--baseline); }
footer { margin-top: 20px; color: var(--text-muted); font-size: 0.75rem; }
`;

function fmt(v) {
  return v == null ? '' : '$' + v.toFixed(2);
}

function buildHtml(dataset) {
  const categoryOptions = CATEGORIES
    .map(c => `<option value="${c.range[0]}-${c.range[1]}">${c.label} (${c.range[0]}–${c.range[1]})</option>`)
    .join('\n        ');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Site-of-Service Price Comparison</title>
<style>${CSS}</style>
</head><body>
<h1>Medicare Site-of-Service Price Comparison</h1>
<div class="subtitle">Office vs. ASC vs. hospital outpatient, same CPT/HCPCS code &middot; Austin, TX &middot; CY2026 &middot; ${dataset.length.toLocaleString()} codes</div>

<div class="panel">
  <div class="controls">
    <div class="field grow">
      <label for="category">Category (quick pick)</label>
      <select id="category">
        <option value="">Custom range / all codes</option>
        ${categoryOptions}
      </select>
    </div>
    <div class="field">
      <label for="rangeFrom">Code from</label>
      <input type="text" id="rangeFrom" placeholder="e.g. 26010">
    </div>
    <div class="field">
      <label for="rangeTo">Code to</label>
      <input type="text" id="rangeTo" placeholder="e.g. 26989">
    </div>
    <div class="field grow">
      <label for="keyword">Keyword (searches description)</label>
      <input type="text" id="keyword" placeholder="e.g. tendon repair">
    </div>
    <div class="field grow">
      <label for="codeList">Or paste specific codes (comma-separated)</label>
      <input type="text" id="codeList" placeholder="e.g. 26055, 26010, 26340">
    </div>
    <div class="field checkbox-field">
      <input type="checkbox" id="allThree">
      <label for="allThree">Only codes priced in all 3 settings</label>
    </div>
    <button class="primary" id="searchBtn">Search</button>
    <button id="clearBtn">Clear</button>
  </div>
</div>

<div class="summary-row">
  <span class="result-count" id="resultCount"></span>
  <button id="exportBtn">Export CSV</button>
</div>

<div class="table-wrap">
  <table id="resultsTable">
    <thead>
      <tr>
        <th data-key="code">Code</th>
        <th data-key="code_type">Type</th>
        <th data-key="description">Description</th>
        <th data-key="office_total" class="group-office">Office (total)</th>
        <th data-key="asc_physician" class="group-asc">ASC — Physician</th>
        <th data-key="asc_facility">ASC — Facility</th>
        <th data-key="asc_total">ASC (total)</th>
        <th data-key="hopd_physician" class="group-hopd">Hospital Outpt — Physician</th>
        <th data-key="hopd_facility">Hospital Outpt — Facility</th>
        <th data-key="hopd_total">Hospital Outpt (total)</th>
        <th data-key="notes">Notes</th>
      </tr>
    </thead>
    <tbody id="resultsBody"></tbody>
  </table>
</div>

<footer>
  Physician fee is identical for ASC and hospital outpatient by design — Medicare's Physician Fee Schedule only
  distinguishes facility vs. non-facility, not which facility type. Only the facility fee differs between the two.
  A setting's total is blank when that setting's facility fee isn't separately payable for that code (see Notes) —
  intentional, not missing data. Source: CMS Physician Fee Schedule, OPPS Addendum B, and ASC Payment System
  addenda, Austin TX wage-adjusted, CY2026.
</footer>

<script>
const DATA = ${JSON.stringify(dataset)};
</script>
<script>
(function () {
  const tbody = document.getElementById('resultsBody');
  const resultCount = document.getElementById('resultCount');
  let currentRows = [];
  let sortKey = 'code';
  let sortDir = 1;

  function parseCodeList(text) {
    return text.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  function search() {
    const category = document.getElementById('category').value;
    let from = document.getElementById('rangeFrom').value.trim();
    let to = document.getElementById('rangeTo').value.trim();
    const keyword = document.getElementById('keyword').value.trim().toLowerCase();
    const codeListRaw = document.getElementById('codeList').value.trim();
    const allThree = document.getElementById('allThree').checked;

    if (category) {
      const [a, b] = category.split('-');
      from = a; to = b;
    }

    const codeList = codeListRaw ? parseCodeList(codeListRaw) : null;
    const fromNum = from ? parseInt(from, 10) : null;
    const toNum = to ? parseInt(to, 10) : null;

    currentRows = DATA.filter(row => {
      if (codeList) {
        if (!codeList.includes(row.code)) return false;
      } else if (fromNum != null || toNum != null) {
        const codeNum = parseInt(row.code, 10);
        if (isNaN(codeNum)) return false;
        if (fromNum != null && codeNum < fromNum) return false;
        if (toNum != null && codeNum > toNum) return false;
      }
      if (keyword && !row.description.toLowerCase().includes(keyword)) return false;
      if (allThree && (row.office_total == null || row.asc_total == null || row.hopd_total == null)) return false;
      return true;
    });

    renderTable();
  }

  function clearSearch() {
    document.getElementById('category').value = '';
    document.getElementById('rangeFrom').value = '';
    document.getElementById('rangeTo').value = '';
    document.getElementById('keyword').value = '';
    document.getElementById('codeList').value = '';
    document.getElementById('allThree').checked = false;
    currentRows = [];
    renderTable();
  }

  function fmt(v) {
    return v == null ? '<span class="empty-cell">—</span>' : '$' + v.toFixed(2);
  }

  function renderTable() {
    const sorted = [...currentRows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number') return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });

    resultCount.textContent = currentRows.length
      ? \`\${currentRows.length.toLocaleString()} code\${currentRows.length === 1 ? '' : 's'}\`
      : 'No results yet — pick a category or enter a range above';

    tbody.innerHTML = sorted.map(r => \`
      <tr>
        <td class="code">\${r.code}</td>
        <td>\${r.code_type}</td>
        <td>\${r.description}</td>
        <td class="num">\${fmt(r.office_total)}</td>
        <td class="num">\${fmt(r.asc_physician)}</td>
        <td class="num">\${fmt(r.asc_facility)}</td>
        <td class="num">\${fmt(r.asc_total)}</td>
        <td class="num">\${fmt(r.hopd_physician)}</td>
        <td class="num">\${fmt(r.hopd_facility)}</td>
        <td class="num">\${fmt(r.hopd_total)}</td>
        <td class="notes">\${r.notes || ''}</td>
      </tr>
    \`).join('');
  }

  function exportCsv() {
    if (!currentRows.length) { alert('No results to export — run a search first.'); return; }
    const headers = ['Code', 'Type', 'Description', 'Office (total)', 'ASC - Physician', 'ASC - Facility',
      'ASC (total)', 'Hospital Outpt - Physician', 'Hospital Outpt - Facility', 'Hospital Outpt (total)', 'Notes'];
    const rows = currentRows.map(r => [
      r.code, r.code_type, r.description,
      r.office_total ?? '', r.asc_physician ?? '', r.asc_facility ?? '', r.asc_total ?? '',
      r.hopd_physician ?? '', r.hopd_facility ?? '', r.hopd_total ?? '', r.notes || ''
    ]);
    const csv = [headers, ...rows].map(row =>
      row.map(cell => {
        const s = String(cell);
        return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',')
    ).join('\\r\\n');
    const blob = new Blob(['\\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'site-of-service-prices.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('searchBtn').addEventListener('click', search);
  document.getElementById('clearBtn').addEventListener('click', clearSearch);
  document.getElementById('exportBtn').addEventListener('click', exportCsv);
  document.getElementById('category').addEventListener('change', search);
  [ 'rangeFrom', 'rangeTo', 'keyword', 'codeList' ].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  });
  document.querySelectorAll('thead th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) { sortDir *= -1; } else { sortKey = key; sortDir = 1; }
      renderTable();
    });
  });

  renderTable();
})();
</script>
</body></html>`;
}

function main() {
  const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });
  const html = buildHtml(dataset);
  writeFileSync(OUT_PATH, html, 'utf-8');
  console.log(`Wrote ${OUT_PATH} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
}

main();
