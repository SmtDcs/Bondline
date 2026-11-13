// node app/scripts/verify-fixtures.mjs (run from the repo root)
// Offline re-check of every recorded receipt bundle in fixtures/live and fixtures/simulated.
// A bundle whose file name contains "tampered" must FAIL the response-hash check; that is what it
// demonstrates. A file that cannot be parsed, or that fails for another reason, is not "detected".
// Real bundles must also use a signing_address listed as verified in fixtures/attestation/*.json;
// simulated bundles print PASS (SIMULATED key). Exit 0 = every bundle behaved as expected (last line ALL VERIFIED (<n> bundles)), 1 = SOME FAILED.
import fs from 'node:fs'; import path from 'node:path';
import { checkBundle } from '../lib/nearai.mjs';
import { loadAttestations, attestedSignerSet } from '../lib/attestation.mjs';

const DIRS = ['fixtures/live', 'fixtures/simulated'];
const ATTEST_DIR = 'fixtures/attestation';
const attested = attestedSignerSet(loadAttestations(ATTEST_DIR));
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
  // v3 live run: requests the customer made herself (no shop tag / a tag she signed). They carry a genuine TEE signature
  // and must be refused at exactly the shop-authorization row, the same refusal the contract gave on chain.
  const refused = /self-made|forged-tag|wrong-buyer/.test(path.basename(file));
  let firstFail;
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    firstFail = checkBundle(bundle).find(r => !r.ok);
  } catch (e) {
    firstFail = { check: `cannot read bundle: ${e.message}` };
  }
  if (refused) {
    const fails = (() => { try { return checkBundle(bundle).filter(r => !r.ok); } catch { return [{ check: 'unreadable' }]; } })();
    if (fails.length === 1 && fails[0].check.startsWith('shop authorization in the request bytes (v3)')) {
      console.log(`PASS ${file} (request refused: no valid shop authorization for this buyer)`);
    } else {
      failed = true;
      console.log(`FAIL ${file} expected exactly the shop-authorization check to fail (failed: ${fails.map(f => f.check).join('; ') || 'none'})`);
    }
  } else if (tampered) {
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
    // A simulated bundle is signed with a fake key; never present it as a real receipt.
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

const isRefused = (f) => /self-made|forged-tag|wrong-buyer/.test(path.basename(f));
const isTampered = (f) => path.basename(f).includes('tampered');
const tamperedCount = files.filter(isTampered).length;
const refusedCount = files.filter(isRefused).length;
const simulatedCount = files.filter(f => { if (isTampered(f) || isRefused(f)) return false; try { return JSON.parse(fs.readFileSync(f, 'utf8')).simulated === true; } catch { return false; } }).length;
const realCount = files.length - simulatedCount - tamperedCount - refusedCount;
// Real, tampered and simulated counts are never merged: SIMULATED bundles use a publicly known fake key and are not TEE
// evidence; a tampered copy is a real receipt edited on purpose, which must FAIL.
const counts = `${realCount} real bundles${tamperedCount > 0 ? ` + ${tamperedCount} tampered (correctly rejected)` : ''}${refusedCount > 0 ? ` + ${refusedCount} refused (self-made or wrong-buyer requests: no valid shop authorization)` : ''}${simulatedCount > 0 ? ` + ${simulatedCount} SIMULATED (fake key, not TEE evidence)` : ''}`;
console.log(failed ? 'SOME FAILED' : `ALL VERIFIED (${counts})`);
process.exit(failed ? 1 : 0);
