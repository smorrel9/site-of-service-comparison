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
 *
 * EXCEPTION — codes with a genuine professional/technical (26/TC) component
 * split, mostly radiology/imaging. For these, equal nonfac_pe/facility_pe on
 * the GLOBAL row does NOT mean "never done in office" — it's a structural
 * side effect of how PC/TC RVUs are built (the global row's PE RVU is just
 * the 26 + TC rows summed, and technical/equipment cost doesn't carry a
 * facility-vs-non-facility differential the way genuinely site-flexible
 * procedures do). Chest X-ray (71046) and even MRI (73721) are routinely
 * billed globally by practices/imaging centers that own their own equipment
 * — the "global tier" for practice-licensed outpatient imaging. Verified by
 * hand against the raw RVU file for both codes: global PE RVU == 26 PE RVU +
 * TC PE RVU exactly, for both facility and non-facility columns. Codes with
 * a real 26/TC split (see scripts/extract-pc-tc-codes.js,
 * data/pc-tc-split-codes.json — 1,132 codes, mostly radiology) are exempted
 * from the exact-match exclusion above; they still go through the 15x ratio
 * check below like any other code.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';

// Second exemption from the Pass 2 ratio heuristic (see file header and
// README "Known limitations"): the Cardiovascular System CPT chapter
// (33016-37799) is a well-documented office/OBL-based specialty area —
// vascular access, venous procedures (sclerotherapy, PICC lines), cardiac
// device implants (loop recorders), and peripheral vascular intervention
// (atherectomy, IVL, stenting) are routinely done in office-based labs, a
// widely-recognized trend directly tied to CMS's non-facility payment for
// these codes. A huge ratio here (found some at 200x+) usually reflects real
// expensive disposable cost (atherectomy catheters, IVL devices, stents,
// drug-coated balloons — often $3,000-$10,000+ each), not an unrealistic
// theoretical allocation. Verified: Pass 1 (exact-match) already catches
// genuinely facility-only codes within this chapter on its own (e.g. 33533,
// CABG, ratio exactly 1.0 — never reaches Pass 2), so exempting the whole
// chapter from Pass 2 is safe rather than needing a narrower sub-range.
// Percutaneous AV fistula creation (36836, 36837) — a newer, less-invasive
// dialysis-access technique tied to office-based vascular access centers —
// sits in this range too. Does NOT cover neuro-interventional codes (e.g.
// 61626, vascular embolization) which live in the Nervous System chapter
// (61000-64999) and stay subject to Pass 2 — confirmed clinically
// inappropriate for a standard office by the person who caught this bug.
const OFFICE_RATIO_EXEMPT_RANGES = [
  [33016, 37799], // Cardiovascular System
];

function isInExemptRange(code) {
  const n = parseInt(code, 10);
  if (isNaN(n)) return false;
  return OFFICE_RATIO_EXEMPT_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'prices.db');
const OUT_PATH = path.join(DATA_DIR, 'site-of-service-dataset.json');
const PC_TC_PATH = path.join(DATA_DIR, 'pc-tc-split-codes.json');

const PC_TC_SPLIT_CODES = existsSync(PC_TC_PATH)
  ? new Set(JSON.parse(readFileSync(PC_TC_PATH, 'utf-8')))
  : new Set();
if (PC_TC_SPLIT_CODES.size === 0) {
  console.warn('WARNING: data/pc-tc-split-codes.json not found or empty — run scripts/extract-pc-tc-codes.js first.');
  console.warn('Radiology/imaging codes with a genuine PC/TC split may be wrongly excluded from Office without it.');
}

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

function buildNotes({ code, hasOffice, officeNotDifferentiated, officeRatioFlagged, officeRatio, oppsSI, oppsPayable, oppsPayment, ascIndicator, ascPayable, ascFound }) {
  const notes = [];

  if (officeNotDifferentiated) {
    notes.push("Office: not typically performed in-office — Medicare's fee schedule doesn't differentiate an office rate for this code (non-facility PE RVU defaults to the facility value).");
  } else if (officeRatioFlagged) {
    notes.push(`Office: excluded, unverified heuristic — non-facility PE RVU is ${officeRatio.toFixed(0)}x the facility PE RVU (threshold: 15x), typical of equipment/supply cost allocated to a theoretical office setting rather than real-world practice. Flagged for hand-curation, not confirmed. See README.`);
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

  let pcTcRescued = 0;
  const dataset = rows.map(r => {
    const rawHasOffice = (r.nonfac_rate ?? 0) > 0;
    const hasPcTcSplit = PC_TC_SPLIT_CODES.has(r.code);
    // CMS defaults non-facility PE RVU to the facility PE RVU when a code
    // isn't realistically performed in an office — same value means no real
    // office rate was calculated, regardless of whether nonfac_rate > 0.
    // EXCEPT for codes with a genuine PC/TC split (see file header) — equal
    // PE RVU there is structural, not a site-of-service signal.
    const rawPeEqual = rawHasOffice && Math.abs((r.nonfac_pe_rvu ?? 0) - (r.facility_pe_rvu ?? 0)) < 0.001;
    const officeNotDifferentiated = rawPeEqual && !hasPcTcSplit;
    if (rawPeEqual && hasPcTcSplit) pcTcRescued++;

    // Second pass, UNVERIFIED HEURISTIC (tagged for hand-curation — see
    // README "Known limitations"): some codes get a genuinely differentiated
    // but unrealistically large non-facility PE RVU, reflecting theoretical
    // equipment/supply cost allocated to an office setting that wouldn't
    // realistically stock it (e.g. 61626, vascular embolization: 75.7x ratio,
    // $10,248 "office" price vs $746.74 facility). No clean CMS data flag
    // exists for this — checked the raw RVU file's NON-FAC NA INDICATOR
    // column directly, it's blank for 61626, so that's not it either.
    // Threshold picked by calibrating against known-legitimate office
    // procedures (EKG, laceration repair, eye exam, joint injection — all
    // ran 1x-8x); 15x sits comfortably above all of them. This WILL have
    // false positives/negatives at the margin; revisit with a curated list.
    const OFFICE_RATIO_THRESHOLD = 15;
    const officeRatioExempt = isInExemptRange(r.code);
    const officeRatio = (!officeNotDifferentiated && rawHasOffice && (r.facility_pe_rvu ?? 0) > 0)
      ? (r.nonfac_pe_rvu ?? 0) / r.facility_pe_rvu
      : null;
    const officeRatioFlagged = !officeRatioExempt && officeRatio != null && officeRatio > OFFICE_RATIO_THRESHOLD;

    const hasOffice = rawHasOffice && !officeNotDifferentiated && !officeRatioFlagged;
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
      officeRatioFlagged,
      officeRatio,
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
      office_flagged_unverified: officeRatioFlagged, // tag for hand-curation follow-up — see README
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
  const ratioFlagged = filtered.filter(d => d.office_flagged_unverified).length;
  console.log(`  Office excluded by 15x ratio heuristic (unverified, tagged for hand-curation): ${ratioFlagged}`);
  console.log(`  Office rescued by PC/TC-split exemption (radiology/imaging global billing): ${pcTcRescued}`);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(filtered), 'utf-8');
  console.log(`\nWrote ${OUT_PATH} (${(JSON.stringify(filtered).length / 1024 / 1024).toFixed(2)} MB)`);

  db.close();
}

main();
