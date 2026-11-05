// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 실험: 카메라에 넣기 전에 궤적을 다듬어 멈춤과 방향 전환을 앞서 준비하게 합니다. 제품에 적용되어 있지 않습니다.
//
// 영상을 저장하는 흐름은 궤적 전체를 미리 알고 있습니다. 그래서 미래 값을 예측하는 대신 실제 미래를 볼 수 있습니다.
//   1. 순간 튐 제거: 이동 중앙값에서 크게 벗어난 점을 고칩니다.
//   2. 앞서 보기: 카메라가 보는 위치를 leadSec 만큼 앞당겨 사람이 움직이기 전에 준비하게 합니다.
//   3. 시차 없는 평활: 앞뒤 대칭 가우시안으로 멈춤 전 감속을 부드럽게 만듭니다.
const OK = (p) => p.state !== 'TARGET_LOST' && p.bbox;

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function detectEvents(pts, { speedStop = 0.03, minSec = 0.3 } = {}) {
  const c = pts.map((p) => (OK(p) ? p.bbox.x + p.bbox.width / 2 : null));
  const events = [];
  let lastSign = 0, lastT = -Infinity;
  for (let i = 3; i < pts.length - 3; i += 1) {
    if (c[i - 3] === null || c[i + 3] === null) continue;
    const dt = pts[i + 3].timestamp - pts[i - 3].timestamp;
    const before = (c[i] - c[i - 3]) / (dt / 2), after = (c[i + 3] - c[i]) / (dt / 2);
    const t = pts[i].timestamp;
    let kind = null;
    if (Math.abs(before) > speedStop && Math.abs(after) < speedStop / 2) kind = 'stop';
    else if (Math.abs(before) > speedStop && Math.abs(after) > speedStop && Math.sign(before) !== Math.sign(after)) kind = 'turn';
    if (kind && t - lastT >= minSec) { events.push({ t, kind }); lastT = t; }
    lastSign = Math.sign(after) || lastSign;
  }
  return events;
}

/**
 * adaptiveSpeed: 값이 있으면 대상이 빠를수록 앞서 보기와 평활을 줄입니다(초당 키 배수 기준).
 * 고정 값은 안무와 질주에서 대상을 화면 밖으로 밀어냈습니다. 느릴 때만 부드럽게 다듬는 것이 목적입니다.
 */
export function anticipateTrack(pts, { leadSec = 0.15, sigmaSec = 0.15, spikeWindow = 2, spikeHeights = 0.35, adaptiveSpeed = null } = {}) {
  const n = pts.length;
  const value = (p, key) => (key === 'cx' ? p.bbox.x + p.bbox.width / 2 : key === 'cy' ? p.bbox.y + p.bbox.height / 2 : key === 'w' ? p.bbox.width : p.bbox.height);
  const keys = ['cx', 'cy', 'w', 'h'];
  const clean = Object.fromEntries(keys.map((k) => [k, pts.map((p) => (OK(p) ? value(p, k) : null))]));
  // 1. 순간 튐
  for (let i = 0; i < n; i += 1) {
    if (clean.cx[i] === null) continue;
    const near = [];
    for (let j = Math.max(0, i - spikeWindow); j <= Math.min(n - 1, i + spikeWindow); j += 1) if (clean.cx[j] !== null) near.push(j);
    if (near.length < 3) continue;
    const m = median(near.map((j) => pts[j].bbox.x + pts[j].bbox.width / 2));
    if (Math.abs(clean.cx[i] - m) > spikeHeights * clean.h[i] * (9 / 16)) {
      clean.cx[i] = m;
      clean.w[i] = median(near.map((j) => pts[j].bbox.width));
      clean.h[i] = median(near.map((j) => pts[j].bbox.height));
    }
  }
  // 2·3. 앞당겨 보고 끊긴 구간을 넘지 않는 대칭 평활
  const out = pts.map((p) => ({ ...p, bbox: p.bbox ? { ...p.bbox } : p.bbox }));
  const speedAt = (i) => {
    let peak = 0;
    for (let j = Math.max(1, i - 3); j <= Math.min(n - 1, i + 3); j += 1) {
      if (clean.cx[j] === null || clean.cx[j - 1] === null) continue;
      const dt = Math.max(1e-3, pts[j].timestamp - pts[j - 1].timestamp);
      peak = Math.max(peak, Math.abs(clean.cx[j] - clean.cx[j - 1]) / dt / Math.max(1e-3, clean.w[i]));
    }
    return peak;
  };
  for (let i = 0; i < n; i += 1) {
    if (clean.cx[i] === null) continue;
    const scale = adaptiveSpeed ? 1 / (1 + (speedAt(i) / adaptiveSpeed) ** 2) : 1;
    const sigma = sigmaSec * scale;
    const t0 = pts[i].timestamp + leadSec * scale;
    const acc = { cx: 0, cy: 0, w: 0, h: 0 };
    let weight = 0;
    const walk = (dir) => {
      for (let j = dir > 0 ? i : i - 1; j >= 0 && j < n; j += dir) {
        if (clean.cx[j] === null) break;
        const d = pts[j].timestamp - t0;
        if (Math.abs(d) > Math.max(sigma, 0.051) * 3) { if ((dir > 0 && d > 0) || (dir < 0 && d < 0)) break; continue; }
        const g = sigma > 1e-3 ? Math.exp(-(d * d) / (2 * sigma * sigma)) + 1e-6 : Number(Math.abs(d) < 0.051);
        for (const k of keys) acc[k] += clean[k][j] * g;
        weight += g;
      }
    };
    walk(1);
    walk(-1);
    if (weight <= 1e-6) continue;
    const w = acc.w / weight, h = acc.h / weight;
    out[i].bbox = { x: acc.cx / weight - w / 2, y: acc.cy / weight - h / 2, width: w, height: h };
  }
  return out;
}
