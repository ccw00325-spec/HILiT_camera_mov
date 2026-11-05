// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// A/B 비교: A = 제품 카메라(runtime), B = 제품 카메라 + 궤적 앞서 보기(lab). 합성 궤적이므로 실제 영상 품질이 아닙니다.
//   npm run ab                                   표로 출력
//   npm run ab -- --lead 0.2 --sigma 0.15        B 값 바꾸기
//   npm run ab -- --check                        A 가 eval/baseline.json 보다 나빠지면 실패
//   npm run ab -- --write-baseline               기준값 다시 쓰기
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anticipateTrack } from '../lab/lookahead.mjs';
import { FPS, measurePath } from './lib/camera-metrics.mjs';
import { buildTrack, SCENES, SRC } from './lib/trajectories.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { plannedFollowCamera } = await import(pathToFileURL(path.join(ROOT, 'runtime/packages/tracking-core/src/follow-plan.ts')).href);
const SETTINGS = { sourceWidth: SRC.width, sourceHeight: SRC.height, aspect: 'portrait', zoom: 0.42, maxUpscale: 2.6 };
export const SEEDS = [1, 2, 3, 4];

export function runPath(pts, truth) {
  const windows = [{ start: pts[0].timestamp, end: pts.at(-1).timestamp }];
  const cam = plannedFollowCamera(SETTINGS, pts, windows);
  const path2 = [], target = [];
  for (let t = windows[0].start; t <= windows[0].end + 1e-6; t += 1 / FPS) {
    const r = cam.frameAt(pts, t);
    path2.push({ t, sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh });
    const g = truth[Math.min(truth.length - 1, Math.round(t * 10))];
    target.push(g?.box ?? null);
  }
  return measurePath(path2, target);
}

export function evaluate(options = {}, seeds = SEEDS) {
  const table = {};
  const avg = (rows) => Object.fromEntries(Object.keys(rows[0]).map((k) => [k, +(rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length).toFixed(3)]));
  for (const name of Object.keys(SCENES)) {
    const a = [], b = [];
    for (const seed of seeds) {
      const { pts, truth } = buildTrack(name, { seed });
      a.push(runPath(pts, truth));
      b.push(runPath(anticipateTrack(pts, options), truth));
    }
    table[name] = { A: avg(a), B: avg(b) };
  }
  return table;
}

const COLS = [['accP95', '가속 P95'], ['jerkP95', '저크 P95'], ['maxStepPct', '최대 이동%'], ['panReversalsPerMin', '방향 전환/분'], ['insideRate', '포함률%'], ['centerErrP95', '중심 오차'], ['leadLagSec', '시차(초)']];
export function report(table) {
  const lines = [`| 장면 | 판 | ${COLS.map((c) => c[1]).join(' | ')} |`, `|---|---|${COLS.map(() => '---:').join('|')}|`];
  for (const [name, row] of Object.entries(table)) for (const k of ['A', 'B']) lines.push(`| ${name} | ${k} | ${COLS.map((c) => row[k][c[0]]).join(' | ')} |`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const num = (name, d) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : d; };
  const table = evaluate({ leadSec: num('--lead', 0.08), sigmaSec: num('--sigma', 0.2), adaptiveSpeed: num('--adaptive', 2) });
  const text = report(table);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 카메라 A/B (합성 궤적)\n\n${text}\n`);
  const file = path.join(ROOT, 'eval/baseline.json');
  if (args.includes('--write-baseline')) {
    const A = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.A]));
    writeFileSync(file, `${JSON.stringify({ note: 'Synthetic regression baseline of the product camera (A). Not real-footage quality.', seeds: SEEDS, A }, null, 2)}\n`);
    console.log('기준값을 썼습니다.');
  }
  if (args.includes('--check')) {
    const base = JSON.parse(readFileSync(file, 'utf8')).A;
    const worse = [];
    for (const [k, v] of Object.entries(base)) {
      const now = table[k].A;
      if (now.accP95 > v.accP95 * 1.15 + 0.01) worse.push(`${k} 가속 ${v.accP95}→${now.accP95}`);
      if (now.jerkP95 > v.jerkP95 * 1.15 + 0.5) worse.push(`${k} 저크 ${v.jerkP95}→${now.jerkP95}`);
      if (now.insideRate < v.insideRate - 1) worse.push(`${k} 포함률 ${v.insideRate}→${now.insideRate}`);
    }
    if (worse.length) { console.error(`기준보다 나빠졌습니다:\n  ${worse.join('\n  ')}`); process.exit(1); }
    console.log('기준값 이내입니다.');
  }
}
