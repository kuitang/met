#!/usr/bin/env node
/**
 * E2E wait-discipline guard — CI-enforced (see e2e/playwright.config.ts
 * "TIMEOUT BUDGET" and the forensics in PR "e2e: fast deterministic checks").
 *
 * The checks suite runs against a static export that serves in milliseconds:
 * a long timeout only measures something that does not exist, and an
 * unconditional pause is a race wearing a trench coat. History: CI runs
 * 27312485379/27313603005 burned ~25 min each on 62 identical 45 s
 * element-not-found timeouts from ONE root cause.
 *
 * Rules, applied to e2e/checks/** (the CI gate — journeys are deliberately
 * paced video recordings and exempt):
 *   1. no page.waitForTimeout(...) / setTimeout-as-sleep;
 *   2. no waitForLoadState('networkidle') (load-state heuristics, not
 *      conditions);
 *   3. no configured timeout above 10_000 ms (expect/action/test.setTimeout).
 *
 * Exception mechanism: a `e2e-discipline: allow(<justification>)` comment on
 * the offending line or within the 2 lines above it (a two-line comment
 * directly above the code). The justification is mandatory — bare "allow"
 * fails. Legitimate uses are synthetic-gesture
 * pacing (velocity is a function of time) and REAL_TARGET-gated specs that
 * download real network bytes (skipped in CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKS_DIR = path.join(ROOT, 'e2e', 'checks');
const MAX_TIMEOUT_MS = 10_000;
const ALLOW = /e2e-discipline:\s*allow\(.{8,}/; // justification required

const violations = [];

const files = fs
  .readdirSync(CHECKS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(CHECKS_DIR, f));

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(ROOT, file);

  const allowed = (i) => lines.slice(Math.max(0, i - 2), i + 1).some((l) => ALLOW.test(l));
  const flag = (i, rule, detail) => {
    if (!allowed(i)) violations.push(`${rel}:${i + 1}  [${rule}]  ${detail ?? lines[i].trim()}`);
  };

  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, ''); // ignore comment text
    if (/\.waitForTimeout\s*\(/.test(code)) flag(i, 'no-unconditional-wait');
    if (/new Promise[^;]*setTimeout/.test(code)) flag(i, 'no-sleep');
    if (/waitForLoadState\s*\(\s*['"`]networkidle/.test(code)) flag(i, 'no-networkidle');

    // Any numeric timeout configured in a spec: `timeout: N`, `setTimeout(N)`.
    for (const m of code.matchAll(/(?:timeout\s*:\s*|test\.setTimeout\s*\(\s*)([0-9][0-9_]*)/g)) {
      const ms = Number(m[1].replaceAll('_', ''));
      if (ms > MAX_TIMEOUT_MS) {
        flag(i, 'timeout-budget', `${ms} ms > ${MAX_TIMEOUT_MS} ms budget: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error('e2e wait-discipline violations (see scripts/check-e2e-discipline.mjs):\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\n${violations.length} violation(s). Replace pauses with element/condition waits` +
      ' (e2e/helpers/settle.ts) or, if genuinely time-shaped (gesture velocity,' +
      ' real network bytes), annotate: // e2e-discipline: allow(<why>)',
  );
  process.exit(1);
}
console.log(`e2e discipline: ${files.length} checks specs clean (waits conditional, timeouts ≤${MAX_TIMEOUT_MS} ms)`);
