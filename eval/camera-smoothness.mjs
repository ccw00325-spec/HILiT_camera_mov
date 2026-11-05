// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
/* 내 영상의 궤적으로 제품 카메라를 재는 도구.
 *   node --no-warnings --import ./eval/cam-root-loader.mjs eval/camera-smoothness.mjs <궤적.json> [portrait,source]
 * 궤적.json: [{ meta:{width,height,srcWidth,srcHeight}, trajectory:[{t,state,box(라벨 px)}] }]
 * 지표: 30fps 크롭 중심의 가속도 RMS·P95(크롭 폭/초²), 가로 저크 P95, 줌 가속 P95, 분당 팬 방향 바뀜,
 *       추적 정상 점에서 상자가 크롭 안에 온전히 든 비율, 가로 중심 오차 P95. 한 프레임에 크롭 폭 10% 넘게 뛴 컷 순간은 가속 지표에서 뺀다.
 *       추적 상자 기준이라 정확도가 아니다(추적이 틀리면 같이 틀린다). */
/* 카메라 부드러움·구도 측정. CAM_ROOT 의 follow-plan.ts 로 편집기와 같은 카메라를 만든다. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.CAM_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
const { plannedFollowCamera } = await import(pathToFileURL(ROOT + '/packages/tracking-core/src/follow-plan.ts').href);
const clips = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const aspects = (process.argv[3] || 'portrait,source').split(',');
const FPS = 30;
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] ?? 0; };
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
const agg = {};
for (const aspect of aspects) {
  const acc = [], jerk = [], zacc = [], inside = [], cerr = [], rev = []; let dur = 0;
  for (const c of clips) {
    const W = c.meta.width, H = c.meta.height, SW = c.meta.srcWidth, SH = c.meta.srcHeight;
    const pts = c.trajectory.filter((p) => p.box).map((p) => ({ timestamp: p.t, state: p.state, confidence: p.confidence ?? 0.9,
      bbox: { x: p.box.x / W, y: p.box.y / H, width: p.box.width / W, height: p.box.height / H } }));
    if (pts.length < 3) continue;
    const t0 = pts[0].timestamp, t1 = pts[pts.length - 1].timestamp;
    const cam = plannedFollowCamera({ sourceWidth: SW, sourceHeight: SH, aspect, zoom: 0.42, maxUpscale: 2.6 }, pts, [{ start: t0, end: t1 }]);
    const cx = [], cy = [], ch = [], cw = [];
    for (let t = t0; t <= t1; t += 1 / FPS) {
      const r = cam.frameAt(pts, t); cx.push(r.sx + r.sw / 2); cy.push(r.sy + r.sh / 2); ch.push(r.sh); cw.push(r.sw);
      // 추적 상자(정상 점만) 기준 구도
      let k = pts.findIndex((p) => p.timestamp >= t); if (k < 0) k = pts.length - 1;
      const p = pts[k];
      if (p.state === 'TRACKING_OK' && Math.abs(p.timestamp - t) < 0.06) {
        const b = p.bbox, x0 = b.x * SW, x1 = (b.x + b.width) * SW, y0 = b.y * SH, y1 = (b.y + b.height) * SH;
        inside.push(x0 >= r.sx - 1 && x1 <= r.sx + r.sw + 1 && y0 >= r.sy - 1 && y1 <= r.sy + r.sh + 1 ? 1 : 0);
        cerr.push(Math.abs((x0 + x1) / 2 - (r.sx + r.sw / 2)) / r.sw);
      }
    }
    dur += t1 - t0;
    let lastSign = 0;
    for (let i = 3; i < cx.length; i += 1) {
      const nx = cw[i], ny = ch[i];
      const ax = (cx[i] - 2 * cx[i - 1] + cx[i - 2]) / nx * FPS * FPS, ay = (cy[i] - 2 * cy[i - 1] + cy[i - 2]) / ny * FPS * FPS;
      if (Math.abs(cx[i] - cx[i - 1]) > 0.1 * nx || Math.abs(cx[i - 1] - cx[i - 2]) > 0.1 * nx || Math.abs(cx[i - 2] - cx[i - 3]) > 0.1 * nx) continue;
      acc.push(Math.hypot(ax, ay));
      const jx = (cx[i] - 3 * cx[i - 1] + 3 * cx[i - 2] - cx[i - 3]) / nx * FPS ** 3;
      jerk.push(Math.abs(jx));
      zacc.push(Math.abs((ch[i] - 2 * ch[i - 1] + ch[i - 2]) / ch[i] * FPS * FPS));
      const v = (cx[i] - cx[i - 1]) / nx * FPS; // 크롭 폭/초
      if (Math.abs(v) > 0.02) { const s = Math.sign(v); if (lastSign && s !== lastSign) rev.push(1); lastSign = s; }
    }
  }
  agg[aspect] = { accRms: +rms(acc).toFixed(3), accP95: +q(acc, 0.95).toFixed(3), jerkP95: +q(jerk, 0.95).toFixed(1),
    zoomAccP95: +q(zacc, 0.95).toFixed(3), panReversalsPerMin: +(rev.length / (dur / 60)).toFixed(1),
    insideRate: +(inside.reduce((s, v) => s + v, 0) / inside.length * 100).toFixed(2), centerErrP95: +q(cerr, 0.95).toFixed(4), frames: acc.length };
}
console.log(JSON.stringify(agg));
