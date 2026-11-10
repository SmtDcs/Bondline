// node app/scripts/verify-fixtures.mjs (run from the repo root)
// Offline re-check of every recorded receipt bundle in fixtures/live and fixtures/simulated.
// A bundle whose file name contains "tampered" must FAIL the response-hash check; that is what it
// demonstrates. A file that cannot be parsed, or that fails for another reason, is not "detected".
// Exit 0 = every bundle behaved as expected (last line ALL VERIFIED (<n> bundles)), 1 = SOME FAILED.
import fs from 'node:fs'; import path from 'node:path';
import { checkBundle } from '../lib/nearai.mjs';

const DIRS = ['fixtures/live', 'fixtures/simulated'];
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
  try {
    firstFail = checkBundle(JSON.parse(fs.readFileSync(file, 'utf8'))).find(r => !r.ok);
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
  } else {
    console.log(`PASS ${file}`);
  }
}

if (files.length === 0) {
  failed = true;
  console.log('FAIL no fixture bundles found');
}

console.log(failed ? 'SOME FAILED' : `ALL VERIFIED (${files.length} bundles)`);
process.exit(failed ? 1 : 0);
