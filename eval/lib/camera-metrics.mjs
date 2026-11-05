// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 카메라 경로의 부드러움과 구도 지표. 추적 상자 기준이므로 추적 정확도가 아닙니다.
export const FPS = 30;

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] ?? 0;
};
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));

/** 대상 속도와 카메라 속도의 시차(초). 음수면 카메라가 늦고, 양수면 앞서 움직입니다. */
export function leadLagSec(camX, tgtX, fps = FPS, maxSec = 0.8) {
  const v = (a) => a.slice(1).map((x, i) => x - a[i]);
  const c = v(camX), t = v(tgtX);
  const n = Math.min(c.length, t.length);
  const mc = c.reduce((s, x) => s + x, 0) / n, mt = t.reduce((s, x) => s + x, 0) / n;
  let best = 0, bestScore = -Infinity;
  const R = Math.round(maxSec * fps);
  for (let lag = -R; lag <= R; lag += 1) {
    let s = 0;
    for (let i = Math.max(0, -lag); i < Math.min(n, n - lag); i += 1) s += (c[i] - mc) * (t[i + lag] - mt);
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  return best / fps;
}

/**
 * path: 시각순 크롭 [{ t, sx, sy, sw, sh }], target: 같은 시각의 대상 상자(원본 화소) 또는 null
 */
export function measurePath(path, target = []) {
  const cx = path.map((r) => r.sx + r.sw / 2), cy = path.map((r) => r.sy + r.sh / 2);
  const acc = [], jerk = [], zacc = [], step = [];
  let rev = 0, lastSign = 0;
  for (let i = 3; i < path.length; i += 1) {
    const nx = path[i].sw, ny = path[i].sh;
    step.push(Math.abs(cx[i] - cx[i - 1]) / nx);
    if ([0, 1, 2].some((k) => Math.abs(cx[i - k] - cx[i - k - 1]) > 0.1 * nx)) continue; // 컷 순간은 가속 지표에서 뺀다.
    acc.push(Math.hypot((cx[i] - 2 * cx[i - 1] + cx[i - 2]) / nx * FPS * FPS, (cy[i] - 2 * cy[i - 1] + cy[i - 2]) / ny * FPS * FPS));
    jerk.push(Math.abs((cx[i] - 3 * cx[i - 1] + 3 * cx[i - 2] - cx[i - 3]) / nx * FPS ** 3));
    zacc.push(Math.abs((path[i].sh - 2 * path[i - 1].sh + path[i - 2].sh) / path[i].sh * FPS * FPS));
    const v = (cx[i] - cx[i - 1]) / nx * FPS;
    if (Math.abs(v) > 0.02) { const s = Math.sign(v); if (lastSign && s !== lastSign) rev += 1; lastSign = s; }
  }
  const inside = [], cerr = [], tx = [], ox = [];
  path.forEach((r, i) => {
    const b = target[i];
    if (!b) return;
    inside.push(b.x >= r.sx - 1 && b.x + b.width <= r.sx + r.sw + 1 && b.y >= r.sy - 1 && b.y + b.height <= r.sy + r.sh + 1 ? 1 : 0);
    cerr.push(Math.abs(b.x + b.width / 2 - cx[i]) / r.sw);
    tx.push(b.x + b.width / 2);
    ox.push(cx[i]);
  });
  const minutes = Math.max(1 / FPS, (path.at(-1).t - path[0].t) / 60);
  return {
    accRms: +rms(acc).toFixed(3),
    accP95: +q(acc, 0.95).toFixed(3),
    jerkP95: +q(jerk, 0.95).toFixed(1),
    zoomAccP95: +q(zacc, 0.95).toFixed(3),
    panReversalsPerMin: +(rev / minutes).toFixed(1),
    maxStepPct: +(q(step, 1) * 100).toFixed(2),
    insideRate: inside.length ? +(inside.reduce((s, v) => s + v, 0) / inside.length * 100).toFixed(2) : null,
    centerErrP95: cerr.length ? +q(cerr, 0.95).toFixed(4) : null,
    leadLagSec: tx.length > 20 ? +leadLagSec(ox, tx).toFixed(3) : null,
  };
}
