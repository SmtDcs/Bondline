// node app/scripts/verify-fixtures.mjs (run from the repo root)
// Offline re-check of every recorded receipt bundle in fixtures/live and fixtures/simulated.
// A bundle whose file name contains "tampered" must FAIL the response-hash check; that is what it
// demonstrates. A file that cannot be parsed, or that fails for another reason, is not "detected".
// Real bundles must also use a signing_address listed as verified in fixtures/attestation/*.json;
// simulated bundles print PASS (SIMULATED key). Exit 0 = every bundle behaved as expected (last line ALL VERIFIED (<n> bundles)), 1 = SOME FAILED.
import fs from 'node:fs'; import path from 'node:path';
import { checkBundle } from '../lib/nearai.mjs';

const DIRS = ['fixtures/live', 'fixtures/simulated'];
const ATTEST_DIR = 'fixtures/attestation';
// signing addresses that an attestation record verified (verified[].signer.signingAddress)
const attested = new Set();
if (fs.existsSync(ATTEST_DIR) && fs.statSync(ATTEST_DIR).isDirectory()) {
  for (const f of fs.readdirSync(ATTEST_DIR).filter(f => f.endsWith('.json')).sort()) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(ATTEST_DIR, f), 'utf8'));
      for (const v of rec.verified ?? []) if (v?.signer?.signingAddress) attested.add(String(v.signer.signingAddress).toLowerCase());
    } catch { /* an unreadable record attests nothing */ }
  }
}
const files = [];
let failed = false;

for (const dir of DIRS) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failed = true;
    console.log(`FAIL ${dir} (missing directory)`);
    continue;
  }
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) files.push(path.join(dir, f));
}

for (const file of files) {
  const tampered = path.basename(file).includes('tampered');
  let firstFail;
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    firstFail = checkBundle(bundle).find(r => !r.ok);
  } catch (e) {
    firstFail = { check: `cannot read bundle: ${e.message}` };
  }
  if (tampered) {
    // Only the response-hash check proves the bytes were edited: a corrupt file or a bad
    // signature is not the tamper this fixture demonstrates.
    if (firstFail && firstFail.check.startsWith('sha256(response bytes)')) {
      console.log(`PASS ${file} (tamper detected)`);
    } else if (!firstFail) {
      failed = true;
      console.log(`FAIL ${file} tamper not detected`);
    } else {
      failed = true;
      console.log(`FAIL ${file} tamper not detected (first failure: ${firstFail.check})`);
    }
  } else if (firstFail) {
    failed = true;
    console.log(`FAIL ${file} ${firstFail.check}`);
  } else if (bundle.simulated) {
    // PLAN rule 9: a simulated bundle is signed with a fake key; never present it as a real receipt.
    console.log(`PASS (SIMULATED key) ${file}`);
  } else {
    // Offline checkBundle verifies against the signing_address stored in the bundle itself, which
    // proves self-consistency only. Tie that key to the attestation record the SDK verified.
    const addr = String(bundle.signature?.signing_address ?? '').toLowerCase();
    if (addr && attested.has(addr)) {
      console.log(`PASS ${file}`);
      console.log(`     signing_address ${addr.slice(0, 12)}... is in ${ATTEST_DIR}/ verified signer list: yes`);
    } else {
      failed = true;
      console.log(`FAIL ${file} signing_address ${addr.slice(0, 12)}... not in ${ATTEST_DIR}/ verified signer list`);
    }
  }
}

if (files.length === 0) {
  failed = true;
  console.log('FAIL no fixture bundles found');
}

const simulatedCount = files.filter(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).simulated === true; } catch { return false; } }).length;
if (!failed) console.log(`(${files.length - simulatedCount} real bundles, ${simulatedCount} SIMULATED)`);
console.log(failed ? 'SOME FAILED' : `ALL VERIFIED (${files.length} bundles)`);
process.exit(failed ? 1 : 0);
