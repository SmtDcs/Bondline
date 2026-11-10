// node app/scripts/verify-fixtures.mjs (run from the repo root)
// Offline re-check of every recorded receipt bundle in fixtures/live and fixtures/simulated.
// A bundle whose file name contains "tampered" must FAIL the checks; that is what it demonstrates.
// Exit 0 = every bundle behaved as expected (last line ALL VERIFIED (<n> bundles)), 1 = SOME FAILED.
import fs from 'node:fs'; import path from 'node:path';
import { checkBundle } from '../lib/nearai.mjs';

const DIRS = ['fixtures/live', 'fixtures/simulated'];
const files = DIRS.flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)));

let failed = false;
for (const file of files) {
  const tampered = path.basename(file).includes('tampered');
  let firstFail;
  try {
    firstFail = checkBundle(JSON.parse(fs.readFileSync(file, 'utf8'))).find(r => !r.ok);
  } catch (e) {
    firstFail = { check: `cannot read bundle: ${e.message}` };
  }
  if (tampered) {
    if (firstFail) { console.log(`PASS ${file} (tamper detected)`); continue; }
    failed = true;
    console.log(`FAIL ${file} tamper not detected`);
  } else if (firstFail) {
    failed = true;
    console.log(`FAIL ${file} ${firstFail.check}`);
  } else {
    console.log(`PASS ${file}`);
  }
}

console.log(failed ? 'SOME FAILED' : `ALL VERIFIED (${files.length} bundles)`);
process.exit(failed ? 1 : 0);
