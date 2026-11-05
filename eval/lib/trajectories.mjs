// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 합성 대상 궤적. 움직임의 형태만 흉내 내며, 실제 영상의 카메라워크 품질을 말해 주지 않습니다.
export const SRC = { width: 1920, height: 1080 };
export const SCENES = {
  stop_go: '걷다 멈추기를 반복',
  direction_change: '달리다 갑자기 방향 전환',
  dance_sway: '박자에 맞춘 좌우 안무',
  sprint: '빠른 가속과 정지',
  stage_noise: '무대 조명 잡음: 상자 떨림과 순간 튐',
  loss_recovery: '가림으로 놓친 뒤 다른 자리에서 다시 잡음',
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function motion(name, t) {
  const W = SRC.width;
  switch (name) {
    case 'stop_go': {
      const c = t % 4;
      const moved = Math.floor(t / 4) * 2 + Math.min(c, 2);
      return W * 0.2 + moved * W * 0.07;
    }
    case 'direction_change': {
      const c = t % 6;
      return c < 3 ? W * 0.3 + c * W * 0.13 : W * 0.69 - (c - 3) * W * 0.13;
    }
    case 'dance_sway':
      return W * 0.5 + Math.sign(Math.sin(t * Math.PI)) * (1 - Math.exp(-((t % 1) * 7))) * W * 0.09;
    case 'sprint': {
      const c = t % 5;
      return W * 0.12 + (c < 2.5 ? 0.5 * 0.1 * c * c : 0.3125) * W * 2.4;
    }
    default:
      return W * 0.3 + t * W * 0.04;
  }
}

/** 10fps 추적 점. FollowCamera 가 받는 형식이다. */
export function buildTrack(name, { seconds = 16, seed = 1, fps = 10 } = {}) {
  const r = rng(seed * 2311 + name.length);
  const H = SRC.height, W = SRC.width;
  const boxH = H * 0.4, boxW = boxH * 0.38;
  const noiseX = name === 'stage_noise' ? 0.012 : 0.003;
  const pts = [];
  const truth = [];
  for (let i = 0; i <= seconds * fps; i += 1) {
    const t = i / fps;
    let x = motion(name, t);
    if (name === 'loss_recovery' && t >= 8) x += W * 0.14; // 다시 잡은 자리로 옮겨 감
    const y = H * 0.5;
    const nx = (r() - 0.5) * 2 * noiseX * W;
    const ny = (r() - 0.5) * 2 * noiseX * H;
    let scale = 1 + (r() - 0.5) * (name === 'stage_noise' ? 0.1 : 0.02);
    let px = x + nx;
    let py = y + ny;
    if (name === 'stage_noise' && r() < 0.03) { px += (r() < 0.5 ? -1 : 1) * W * 0.08; scale *= 1.25; } // 순간 튐
    const lost = name === 'loss_recovery' && t >= 6.6 && t < 8;
    const bw = boxW * scale, bh = boxH * scale;
    pts.push({
      timestamp: t,
      state: lost ? 'TARGET_LOST' : 'TRACKING_OK',
      confidence: lost ? 0 : 0.9,
      bbox: { x: (px - bw / 2) / W, y: (py - bh / 2) / H, width: bw / W, height: bh / H },
    });
    truth.push({ t, box: lost ? null : { x: x - boxW / 2, y: y - boxH / 2, width: boxW, height: boxH } });
  }
  return { pts, truth, name, seconds };
}
