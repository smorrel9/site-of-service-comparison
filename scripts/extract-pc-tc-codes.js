/**
 * extract-pc-tc-codes.js
 *
 * One-time extraction: scans the raw CMS PFS RVU file for codes that have a
 * genuine professional (modifier 26) / technical (modifier TC) component
 * split — mostly radiology/imaging codes. Writes data/pc-tc-split-codes.json.
 *
 * Why this matters for the office-exclusion logic in build-dataset.js: for
 * these codes, the GLOBAL row's non-facility PE RVU often exactly equals its
 * facility PE RVU — the same numeric pattern the exact-match rule uses to
 * detect "never done in an office" (e.g. major surgery like 50045). But for
 * PC/TC-split codes this equality means something structurally different:
 * the global row's PE RVU is just the sum of the 26 + TC rows, and a
 * technical component's equipment/supply cost is the same dollar amount
 * regardless of facility context — so there's no genuine site differential
 * built into these codes' RVU construction, independent of whether the
 * procedure is realistically performed in an office. Chest X-ray (71046) and
 * even MRI (73721) are routinely billed globally by practices/imaging
 * centers that own their own equipment — the "global tier" for
 * practice-licensed outpatient imaging. Verified: global nonfac_pe_rvu +
 * facility_pe_rvu both equal the sum of the 26 and TC rows' respective PE
 * RVUs, for both codes checked.
 *
 * Codes in this list are exempted from the exact-match office exclusion in
 * build-dataset.js (they still go through the 15x ratio check like any other
 * code, in case a PC/TC-split code is ALSO genuinely facility-only for some
 * other reason).
 *
 * Source: this repo doesn't have its own copy of the raw PFS RVU file — it's
 * cached in the sibling hospital-price-transparency project
 * (data/PPRRVU2026_Jan_nonQPP.csv, from CMS's RVU26A release). Point
 * RVU_CSV_PATH below at that file (or a fresher one) to regenerate.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'pc-tc-split-codes.json');

const RVU_CSV_PATH = process.argv[2]
  || path.join(__dirname, '..', '..', 'hospital-price-transparency', 'data', 'PPRRVU2026_Jan_nonQPP.csv');

function main() {
  if (!existsSync(RVU_CSV_PATH)) {
    console.error(`Raw RVU file not found at ${RVU_CSV_PATH}`);
    console.error('Pass a path explicitly: node scripts/extract-pc-tc-codes.js /path/to/PPRRVU*.csv');
    process.exit(1);
  }

  const content = readFileSync(RVU_CSV_PATH, 'utf-8');
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => l.startsWith('HCPCS,MOD,'));
  if (headerIdx === -1) throw new Error('Could not find RVU header row');

  const codes = new Set();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const hcpcs = cols[0]?.trim();
    const mod = cols[1]?.trim();
    if (hcpcs && (mod === '26' || mod === 'TC')) {
      codes.add(hcpcs);
    }
  }

  const sorted = [...codes].sort();
  writeFileSync(OUT_PATH, JSON.stringify(sorted), 'utf-8');
  console.log(`Found ${sorted.length} codes with a genuine PC/TC split`);
  console.log(`Wrote ${OUT_PATH}`);
}

main();
