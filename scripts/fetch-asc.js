/**
 * fetch-asc.js
 *
 * Downloads the CMS ASC (Ambulatory Surgical Center) Payment System quarterly
 * addenda and loads them into a standalone medicare_asc_rates table.
 *
 * This is the third site-of-service Medicare rate, alongside the PFS
 * non-facility rate (doctor's office) and PFS facility rate + OPPS facility
 * fee (hospital outpatient) already in medicare_rates. Together they let you
 * compare the same CPT/HCPCS code across office / ASC / hospital outpatient.
 *
 * Data source: CMS ASC Payment Rates Addenda (quarterly).
 *   Landing page: https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc/asc-payment-rates-addenda
 *   Files sit behind an AMA CPT-license click-through (cms.gov/apps/ama/license.asp)
 *   because Addendum AA/BB include copyrighted CPT short descriptors. The
 *   "Accept" button on that page is a plain GET with ?agree=yes&next=Accept
 *   appended to the real file URL — no session/cookie needed, so we can just
 *   hit that URL directly. Verified by inspecting the license page's HTML.
 *
 * We use Addendum AA (covered surgical procedures) and Addendum BB (covered
 * ancillary services, e.g. drugs/devices/radiology billed alongside a
 * procedure). Addendum DD1 (payment indicator legend) is bundled in the same
 * zip and reproduced below for reference — it's short and stable, not worth
 * re-parsing every run.
 *
 * Wage adjustment: ASC payments use the SAME OPPS wage index and the same
 * 60% labor / 40% non-labor split as hospital outpatient (confirmed CY2026
 * final rule — CMS did not adopt a separate ASC-specific labor share). So
 * this reuses the exact Austin wage index constant fetch-opps.js uses, for
 * consistency: payment = national_rate × (0.60 × wage_index + 0.40).
 */

import { existsSync, mkdirSync, readFileSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', 'data');
const ASC_DIR = path.join(DATA_DIR, 'asc');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'prices.db');

// Quarterly file — bump when refreshing. License-gated URL; the query string
// is the "Accept" click, not a real query param on the file itself.
const QUARTER_LABEL = 'July 2026';
const ADDENDUM_URL = 'https://www.cms.gov/files/zip/july-2026-asc-addenda.zip?agree=yes&next=Accept';
const ADDENDUM_ZIP = path.join(ASC_DIR, 'july-2026-asc-addenda.zip');
const AA_CSV_NAME = 'July 2026 ASC Addenda - Addendum AA.07.08.26.csv';
const BB_CSV_NAME = 'July 2026 ASC Addenda - Addendum BB.07.08.26.csv';
const AA_CSV = path.join(ASC_DIR, AA_CSV_NAME);
const BB_CSV = path.join(ASC_DIR, BB_CSV_NAME);

// Same as fetch-opps.js — ASC uses the OPPS wage index, same labor share.
const LABOR_SHARE = 0.60;
const NON_LABOR_SHARE = 0.40;
const AUSTIN_WAGE_INDEX = 0.9721;

// Addendum DD1 legend (bundled in the same zip as AA/BB, reproduced here
// rather than re-parsed each run since it rarely changes). Indicators with a
// populated Payment Rate in AA/BB are payable regardless of this list — the
// list is for the UI tooltip layer, not for filtering.
const PAYMENT_INDICATOR_LEGEND = {
  A2: 'Surgical procedure on ASC list in CY 2007; payment based on OPPS relative payment weight.',
  B5: 'Alternative code may be available; no payment made.',
  D1: 'Ancillary dental service/item; no separate payment made.',
  D2: 'Non office-based dental procedure added in CY 2024 or later.',
  D5: 'Deleted/discontinued code; no payment made.',
  F4: 'Corneal tissue acquisition, hepatitis B vaccine; paid at reasonable cost.',
  G2: 'Non office-based surgical procedure added in CY 2008 or later; payment based on OPPS relative payment weight.',
  H2: 'Brachytherapy source paid separately; payment based on OPPS rate.',
  J7: 'OPPS pass-through device paid separately; contractor-priced.',
  J8: 'Device-intensive procedure; paid at adjusted rate.',
  K2: 'Drugs, biologicals, and radiopharmaceuticals paid separately; payment based on OPPS rate.',
  K5: 'Pricing information and claims data not available. No payment made.',
  K7: 'Unclassified drugs and biologicals; contractor-priced.',
  L1: 'Influenza/pneumococcal vaccine. Packaged; no separate payment made.',
  L6: 'Special payment; New Technology IOL or qualifying non-opioid device.',
  N1: 'Packaged service/item; no separate payment made.',
  P2: 'Office-based procedure added CY 2008+, with MPFS nonfacility PE RVUs; payment based on OPPS relative payment weight.',
  P3: 'Office-based procedure added CY 2008+, with MPFS nonfacility PE RVUs; payment based on MPFS nonfacility PE RVUs.',
  R2: 'Office-based procedure added CY 2008+, without MPFS nonfacility PE RVUs; payment based on OPPS relative payment weight.',
  S2: 'Skin substitute supply group; paid separately; payment based on OPPS rate.',
  Z2: 'Radiology/diagnostic service paid separately; payment based on OPPS relative payment weight.',
  Z3: 'Radiology/diagnostic service paid separately; payment based on MPFS nonfacility PE RVUs.',
};

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));
  console.log(`  Saved to ${dest}`);
}

function unzipCsv(zipPath, csvName, outDir) {
  // Files live inside a "508 Version of <Quarter> ASC Addenda/" subfolder in the zip.
  execSync(`unzip -j -o "${zipPath}" "*${csvName}" -d "${outDir}"`, { stdio: 'pipe' });
  console.log(`  Extracted ${csvName}`);
}

function cleanNumber(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseAddendum(csvPath, kind) {
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  // First few lines are title/disclaimer text; find the real header row.
  const headerIdx = lines.findIndex(l => l.startsWith('HCPCS Code'));
  if (headerIdx === -1) throw new Error(`Could not find header row in ${csvPath}`);
  const dataPortion = lines.slice(headerIdx).join('\n');
  const rows = parse(dataPortion, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  console.log(`  Parsed ${rows.length} rows from Addendum ${kind}`);

  return rows
    .map(r => ({
      code: (r['HCPCS Code'] || '').trim(),
      short_descriptor: (r['Short Descriptor'] || '').trim(),
      payment_indicator: (r[`${QUARTER_LABEL} Payment Indicator`] || '').trim(),
      payment_weight: cleanNumber(r[`${QUARTER_LABEL}  Payment Weight  `] ?? r[`${QUARTER_LABEL} Payment Weight  `] ?? r[`${QUARTER_LABEL} Payment Weight`]),
      payment_rate_national: cleanNumber(r[`${QUARTER_LABEL} Payment Rate `] ?? r[`${QUARTER_LABEL} Payment Rate`]),
      source: kind,
    }))
    .filter(r => r.code);
}

function applyWageIndex(nationalRate) {
  if (nationalRate == null) return null;
  const factor = LABOR_SHARE * AUSTIN_WAGE_INDEX + NON_LABOR_SHARE;
  return Math.round(nationalRate * factor * 100) / 100;
}

function seedDatabase(records) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    DROP TABLE IF EXISTS medicare_asc_rates;
    CREATE TABLE medicare_asc_rates (
      code TEXT PRIMARY KEY,
      short_descriptor TEXT,
      payment_indicator TEXT,
      payment_indicator_definition TEXT,
      payment_weight REAL,
      payment_rate_national REAL,
      payment_rate_austin REAL,
      payable INTEGER,
      source_addendum TEXT,
      quarter TEXT
    );
    CREATE INDEX idx_asc_payable ON medicare_asc_rates(payable);
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO medicare_asc_rates
    (code, short_descriptor, payment_indicator, payment_indicator_definition,
     payment_weight, payment_rate_national, payment_rate_austin, payable,
     source_addendum, quarter)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const r of records) {
      const austinRate = applyWageIndex(r.payment_rate_national);
      insert.run(
        r.code,
        r.short_descriptor || null,
        r.payment_indicator || null,
        PAYMENT_INDICATOR_LEGEND[r.payment_indicator] || null,
        r.payment_weight,
        r.payment_rate_national,
        austinRate,
        r.payment_rate_national != null ? 1 : 0,
        r.source,
        `2026-${QUARTER_LABEL.split(' ')[0]}`
      );
      count++;
    }
  });
  tx();
  console.log(`  Seeded ${count} ASC rate rows`);

  // Sanity checks — procedures commonly done in ASCs, compared against the
  // office (nonfac) and hospital-outpatient (facility + OPPS) rates already
  // in medicare_rates, so the site-of-service story is checkable end to end.
  const samples = ['45380', '66984', '29881', '17000', '43239']; // colonoscopy, cataract, knee arthroscopy, lesion destruction, EGD w/ biopsy
  console.log('\nSample site-of-service comparison (national ASC rate, Austin-adjusted, vs PFS/OPPS):');
  for (const code of samples) {
    const asc = db.prepare(`SELECT * FROM medicare_asc_rates WHERE code = ?`).get(code);
    const pfs = db.prepare(`
      SELECT facility_rate, nonfac_rate, opps_austin_payment, description
      FROM medicare_rates WHERE code = ?
    `).get(code);
    if (!asc && !pfs) { console.log(`  ${code}: NOT FOUND in either source`); continue; }
    const office = pfs ? (pfs.nonfac_rate ?? 0) : null;
    const hopd = pfs ? (pfs.facility_rate ?? 0) + (pfs.opps_austin_payment ?? 0) : null;
    const ascRate = asc?.payable ? asc.payment_rate_austin : null;
    console.log(
      `  ${code} ${pfs?.description ? `(${pfs.description.slice(0, 40)})` : ''}\n` +
      `    Office: ${office != null ? '$' + office.toFixed(2) : 'n/a'}` +
      `   ASC: ${ascRate != null ? '$' + ascRate.toFixed(2) : `n/a (PI=${asc?.payment_indicator || '?'})`}` +
      `   Hospital outpatient: ${hopd != null ? '$' + hopd.toFixed(2) : 'n/a'}`
    );
  }

  db.close();
}

async function main() {
  if (!existsSync(ASC_DIR)) mkdirSync(ASC_DIR, { recursive: true });

  if (!existsSync(ADDENDUM_ZIP)) {
    await downloadFile(ADDENDUM_URL, ADDENDUM_ZIP);
  } else {
    console.log(`Using cached ${ADDENDUM_ZIP}`);
  }

  if (!existsSync(AA_CSV)) unzipCsv(ADDENDUM_ZIP, AA_CSV_NAME, ASC_DIR);
  if (!existsSync(BB_CSV)) unzipCsv(ADDENDUM_ZIP, BB_CSV_NAME, ASC_DIR);

  console.log('Parsing ASC Addendum AA (covered surgical procedures)...');
  const aa = parseAddendum(AA_CSV, 'AA');
  console.log('Parsing ASC Addendum BB (covered ancillary services)...');
  const bb = parseAddendum(BB_CSV, 'BB');

  // AA is the primary surgical-procedure list; BB adds ancillary codes not
  // already in AA (drugs/devices/radiology billed alongside a procedure).
  const seen = new Set(aa.map(r => r.code));
  const bbOnly = bb.filter(r => !seen.has(r.code));
  const all = [...aa, ...bbOnly];
  console.log(`\nCombined: ${aa.length} from AA + ${bbOnly.length} new from BB = ${all.length} total codes`);

  console.log(`Wage adjustment: factor = ${LABOR_SHARE} × ${AUSTIN_WAGE_INDEX} + ${NON_LABOR_SHARE} = ${(LABOR_SHARE * AUSTIN_WAGE_INDEX + NON_LABOR_SHARE).toFixed(4)}`);
  console.log('Seeding database...');
  seedDatabase(all);

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
