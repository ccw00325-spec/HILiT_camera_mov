// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 값 찾기: 대상 포함률을 지키면서 가속과 저크를 가장 줄이는 lab/lookahead 값을 찾습니다. 제품 값을 바꾸지 않습니다.
//   npm run tune                                  제품 판(A)보다 흔들림이 적은 값
//   npm run tune -- --reference ranges.json       사람이 편집한 영상의 수치 범위에 가장 가까운 값
//
// ranges.json: { "accP95": [낮음, 높음], "jerkP95": [낮음, 높음], ... }. eval/measure-path.mjs 로 사람이 편집한 경로를 재서 만듭니다.
import { readFileSync } from 'node:fs';
import { evaluate } from './ab-compare.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--reference');
const ranges = i >= 0 ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : null;
const MAX_INSIDE_DROP = 1;

const seeds = [1, 2];
const results = [];
for (const leadSec of [0, 0.08, 0.15]) {
  for (const sigmaSec of [0.08, 0.12, 0.2, 0.3]) {
    for (const adaptiveSpeed of [null, 2, 1, 0.5]) {
    const table = evaluate({ leadSec, sigmaSec, adaptiveSpeed }, seeds);
    let jerk = 0, acc = 0, n = 0, worstDrop = 0, distance = 0;
    for (const row of Object.values(table)) {
      jerk += row.B.jerkP95 / Math.max(row.A.jerkP95, 1e-6);
      acc += row.B.accP95 / Math.max(row.A.accP95, 1e-6);
      worstDrop = Math.max(worstDrop, row.A.insideRate - row.B.insideRate);
      n += 1;
      if (ranges) for (const [k, [lo, hi]] of Object.entries(ranges)) {
        const v = row.B[k];
        distance += v < lo ? (lo - v) / Math.max(hi - lo, 1e-6) : v > hi ? (v - hi) / Math.max(hi - lo, 1e-6) : 0;
      }
    }
    results.push({ leadSec, sigmaSec, adaptiveSpeed, jerkRatio: +(jerk / n).toFixed(3), accRatio: +(acc / n).toFixed(3), worstInsideDrop: +worstDrop.toFixed(2), distance: +distance.toFixed(3) });
    }
  }
}
const allowed = results.filter((r) => r.worstInsideDrop <= MAX_INSIDE_DROP);
allowed.sort((a, b) => (ranges ? a.distance - b.distance : a.jerkRatio + a.accRatio - b.jerkRatio - b.accRatio));
console.log(`포함률 하락 ${MAX_INSIDE_DROP}% 이내 후보 ${allowed.length}/${results.length}개. 비율은 B÷A 이며 1보다 작으면 더 부드럽습니다.`);
console.table(allowed.slice(0, 6));
if (!allowed.length) console.table(results.sort((a, b) => a.worstInsideDrop - b.worstInsideDrop).slice(0, 4));
console.log('합성 궤적의 결과입니다. 제품에 넣기 전에 실제 영상과 눈으로 확인해야 합니다.');
