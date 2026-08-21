/**
 * build-dataset.js
 *
 * Joins medicare_rates + medicare_asc_rates + friendly_names into one wide,
 * per-code dataset: office / ASC / hospital-outpatient prices, each with
 * their components, plus a plain-language Notes column explaining any blanks.
 *
 * Output: data/site-of-service-dataset.json — consumed by scripts/build-html.js
 * to produce the standalone app page (data embedded inline, no server needed).
 *
 * Column model, per code:
 *   - Office: a single PFS non-facility rate. No components to break out —
 *     it's one bundled physician payment covering office overhead. By CMS
 *     design this number already includes everything a separate facility fee
 *     would otherwise cover (equipment, staff, supplies) — there is no
 *     additional office facility fee to add on top of it. That's WHY office
 *     totals tend to run lower than ASC/hospital totals: the physician is
 *     compensated for absorbing the overhead directly.
 *   - ASC: PFS facility rate (physician component, same number CMS pays for
 *     ANY facility setting) + ASC facility payment (facility component).
 *   - Hospital outpatient: the same PFS facility rate (physician component)
 *     + OPPS facility payment (facility component).
 *   Note the physician component is identical for ASC and hospital outpatient
 *   by design — Medicare's Physician Fee Schedule only distinguishes
 *   "facility" vs "non-facility," not which facility type. Only the facility
 *   fee differs. Called out in the Notes column so it doesn't read as a bug.
 *
 * A setting's Total is only populated when BOTH components are known and
 * separately payable. If a facility fee is packaged/not payable, we leave
 * that setting's facility + total blank rather than showing a physician-fee-
 * only number that could be mistaken for the full price — safer for an
 * analyst pulling this into a spreadsheet without reading fine print.
 *
 * Office exclusion for facility-only procedures: CMS publishes a non-facility
 * PE RVU for essentially every code, even ones never actually performed in an
 * office (e.g. 50045, Nephrotomy w/exploration — major open surgery). The
 * reliable signal is comparing nonfac_pe_rvu to facility_pe_rvu: when they're
 * exactly equal, CMS didn't calculate a genuine differentiated office rate —
 * it just defaulted to the facility PE RVU, meaning there's no real practice
 * pattern of this being done in-office. When they differ, a genuine office
 * rate exists. Verified against the data: ~71% of codes in this dataset hit
 * the equal case (nonfac_rate == facility_rate to the penny) — a much larger
 * share than expected, so this isn't an edge case, it's the norm for
 * anything beyond routine office-based procedures.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'prices.db');
const OUT_PATH = path.join(DATA_DIR, 'site-of-service-dataset.json');

// Same classification the main app's MedicareBanner.jsx uses for OPPS status
// indicators — kept in sync manually since this is a separate project.
const OPPS_PAYABLE_SI = new Set(['J1', 'J2', 'T', 'S', 'V', 'Q1', 'Q2', 'Q3', 'P', 'R', 'S1', 'U']);
const OPPS_NOTES = {
  N: 'Hospital facility fee is bundled into another service, no separate OPPS payment.',
  Q4: 'Conditionally packaged into another service.',
  A: 'Paid under a different Medicare fee schedule (e.g. lab, mammography), not OPPS.',
  C: 'Inpatient-only procedure — not paid under outpatient PPS.',
  B: 'Not paid under outpatient PPS.',
  E1: 'Not paid by Medicare under any fee-for-service system.',
  E2: 'Not recognized by Medicare for outpatient hospital services.',
};

// Mirrors the Addendum DD1 legend already in fetch-asc.js.
const ASC_PAYABLE_INDICATORS = new Set(['A2', 'G2', 'J8', 'P2', 'P3', 'R2', 'Z2', 'Z3', 'H2', 'J7', 'K2', 'K7', 'S2', 'F4', 'L6']);

function classifyCodeType(code) {
  if (/^\d{5}$/.test(code)) return 'CPT';
  return 'HCPCS';
}

function buildNotes({ code, hasOffice, officeNotDifferentiated, oppsSI, oppsPayable, oppsPayment, ascIndicator, ascPayable, ascFound }) {
  const notes = [];

  if (officeNotDifferentiated) {
    notes.push("Office: not typically performed in-office — Medicare's fee schedule doesn't differentiate an office rate for this code (non-facility PE RVU defaults to the facility value).");
  } else if (!hasOffice) {
    notes.push('No office (non-facility) rate published for this code.');
  }

  if (!ascFound) {
    notes.push('Not on the ASC covered-procedures list.');
  } else if (!ascPayable) {
    notes.push(`ASC: ${ASC_INDICATOR_NOTES[ascIndicator] || `payment indicator ${ascIndicator || 'unknown'} — no separate ASC facility payment.`}`);
  }

  if (oppsSI && !oppsPayable) {
    notes.push(`Hospital outpatient: ${OPPS_NOTES[oppsSI] || `status indicator ${oppsSI} — no separate hospital facility payment.`}`);
  } else if (!oppsSI) {
    notes.push('No hospital outpatient (OPPS) data found for this code.');
  }

  return notes.join(' ');
}

// Addendum DD1 legend, condensed to the notes people actually need.
const ASC_INDICATOR_NOTES = {
  N1: 'Packaged — no separate ASC payment.',
  B5: 'Alternative code may be available; no payment made.',
  D1: 'Ancillary dental service — no separate payment.',
  D5: 'Deleted/discontinued code.',
  K5: 'Pricing/claims data not available.',
  L1: 'Vaccine — packaged, no separate payment.',
};

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const rows = db.prepare(`
    SELECT
      mr.code,
      mr.description AS raw_description,
      fn.friendly_name,
      mr.nonfac_rate,
      mr.facility_rate,
      mr.nonfac_pe_rvu,
      mr.facility_pe_rvu,
      mr.opps_status_indicator,
      mr.opps_austin_payment,
      mr.apc_code,
      ar.payment_indicator AS asc_indicator,
      ar.payment_rate_austin AS asc_facility_payment,
      ar.payable AS asc_payable_flag,
      (ar.code IS NOT NULL) AS asc_found
    FROM medicare_rates mr
    LEFT JOIN friendly_names fn ON fn.code = mr.code
    LEFT JOIN medicare_asc_rates ar ON ar.code = mr.code
    WHERE (mr.nonfac_rate > 0 OR mr.facility_rate > 0 OR mr.opps_austin_payment > 0 OR ar.payable = 1)
  `).all();

  console.log(`Read ${rows.length} candidate codes from the database`);

  const dataset = rows.map(r => {
    const rawHasOffice = (r.nonfac_rate ?? 0) > 0;
    // CMS defaults non-facility PE RVU to the facility PE RVU when a code
    // isn't realistically performed in an office — same value means no real
    // office rate was calculated, regardless of whether nonfac_rate > 0.
    const officeNotDifferentiated = rawHasOffice
      && Math.abs((r.nonfac_pe_rvu ?? 0) - (r.facility_pe_rvu ?? 0)) < 0.001;
    const hasOffice = rawHasOffice && !officeNotDifferentiated;
    const officeTotal = hasOffice ? r.nonfac_rate : null;

    const physicianFacilityComponent = (r.facility_rate ?? 0) > 0 ? r.facility_rate : null;

    const oppsSI = r.opps_status_indicator || null;
    const oppsPayable = oppsSI ? OPPS_PAYABLE_SI.has(oppsSI) && (r.opps_austin_payment ?? 0) > 0 : false;
    const hopdFacility = oppsPayable ? r.opps_austin_payment : null;
    const hopdTotal = (physicianFacilityComponent != null && hopdFacility != null)
      ? Math.round((physicianFacilityComponent + hopdFacility) * 100) / 100
      : null;

    const ascFound = !!r.asc_found;
    const ascPayable = ascFound && r.asc_payable_flag === 1 && (r.asc_facility_payment ?? 0) > 0;
    const ascFacility = ascPayable ? r.asc_facility_payment : null;
    const ascTotal = (physicianFacilityComponent != null && ascFacility != null)
      ? Math.round((physicianFacilityComponent + ascFacility) * 100) / 100
      : null;

    const notes = buildNotes({
      code: r.code,
      hasOffice,
      officeNotDifferentiated,
      oppsSI,
      oppsPayable,
      ascIndicator: r.asc_indicator,
      ascPayable,
      ascFound,
    });

    return {
      code: r.code,
      code_type: classifyCodeType(r.code),
      description: r.friendly_name || r.raw_description || '',
      office_total: officeTotal,
      asc_physician: ascPayable ? physicianFacilityComponent : null,
      asc_facility: ascFacility,
      asc_total: ascTotal,
      hopd_physician: oppsPayable ? physicianFacilityComponent : null,
      hopd_facility: hopdFacility,
      hopd_total: hopdTotal,
      opps_status_indicator: oppsSI,
      asc_payment_indicator: r.asc_indicator || null,
      apc_code: r.apc_code || null,
      notes,
    };
  });

  // Drop rows that ended up with literally nothing payable anywhere —
  // these slipped through the SQL filter via a non-payable ASC row only.
  const filtered = dataset.filter(d => d.office_total != null || d.asc_total != null || d.hopd_total != null || d.asc_physician != null || d.hopd_physician != null);

  console.log(`Kept ${filtered.length} codes with at least one usable price point`);

  const withAllThree = filtered.filter(d => d.office_total != null && d.asc_total != null && d.hopd_total != null).length;
  const withTwo = filtered.filter(d => [d.office_total, d.asc_total, d.hopd_total].filter(v => v != null).length === 2).length;
  const withOne = filtered.filter(d => [d.office_total, d.asc_total, d.hopd_total].filter(v => v != null).length === 1).length;
  console.log(`  All 3 settings: ${withAllThree}`);
  console.log(`  2 settings: ${withTwo}`);
  console.log(`  1 setting: ${withOne}`);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(filtered), 'utf-8');
  console.log(`\nWrote ${OUT_PATH} (${(JSON.stringify(filtered).length / 1024 / 1024).toFixed(2)} MB)`);

  db.close();
}

main();
