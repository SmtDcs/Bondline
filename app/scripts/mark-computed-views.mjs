#!/usr/bin/env node
// Usage: node app/scripts/mark-computed-views.mjs fixtures/replay/transcript.json [...]
// Marks the recomputed views of an already recorded replay transcript (see markComputedViews in
// app/lib/transcript.mjs): chat-time preview_claim, tamper.preview_claim and the first step's pre-claim get_merchant
// get `computed: true`, a v2 preview gets its `token`, and the transcript gets `computed_views: true`. Idempotent.
// Nothing else in the file changes and no network call is made.
import fs from 'node:fs';
import { markComputedViews } from '../lib/transcript.mjs';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: node app/scripts/mark-computed-views.mjs <transcript.json> [...]'); process.exit(2); }
for (const file of files) {
  const marked = markComputedViews(JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.writeFileSync(file, JSON.stringify(marked, null, 2) + '\n');
  console.log(`marked ${file}`);
}
