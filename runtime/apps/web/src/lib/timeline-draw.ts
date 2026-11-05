/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Camera Mov — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Camera Mov", the author, and https://github.com/ccw00325-spec/HILiT_camera_mov when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·c4a17e5092db6f38·2084d167 @license @preserve */
import { drawCaption, type CaptionStyle } from '@/lib/caption-overlay';
import type { DrawLayer, TimelineSample } from '@/lib/clip-timeline';
import type { FaceMask } from '@/lib/face-fx';
import { applySkinRgba } from '@/lib/skin-fx';

/**
 * 얼굴 블러 격자: 얼굴 상자의 긴 변을 이 칸 수로 줄였다가 부드럽게 늘린다(축소-확대 블러).
 * ctx.filter 를 지원하지 않는 브라우저(Safari 등)에서도 같은 결과가 나오게 이 방식을 쓴다.
 * 2026-10-31 사용자 결정 「6칸」(Grok 구현 8칸보다 한 단계 강하게). 실제 사람 얼굴로 알아볼 수 없는지는 아직 미측정이다.
 */
export const FACE_BLUR_CELLS = 6;

type Video = CanvasImageSource & { videoWidth?: number; videoHeight?: number; currentTime?: number; seeking?: boolean };
type Scratch = { width: number; height: number; getContext(type: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null };

export interface DrawOptions {
  /**
   * 실제로 그려지는 프레임의 원본 시각. 찾아가는 중(seeking)이면 아직 이전 프레임이 그려지므로
   * 마지막으로 표시된 시각을 돌려준다. 없으면 video.currentTime(찾는 중이면 계획 시각과 합집합).
   */
  mediaTimeOf?: (decoderKey: string, video: Video) => number | null;
  /**
   * 실제 프레임 시각의 가림 영역(clip-timeline 의 faceMasksForClip). 없으면 layer.faceMasks 를 그대로 쓴다.
   * null 은 "그 시각의 얼굴을 모른다"(분석 범위 밖 프레임) — 가린 척하지 않고 실패로 센다.
   */
  masksAt?: (layer: DrawLayer, mediaTime: number) => FaceMask[] | null;
  /** 블러용 작은 캔버스. 없으면 document/OffscreenCanvas 로 만든다. */
  createScratch?: () => Scratch | null;
  /** off 이면 피부 보정만 빼고 가리기와 구도는 그대로 그린다. */
  skinMode?: 'on' | 'off';
  /**
   * 피부는 이 레이어 캔버스에 그린 뒤 합성한다.
   * 출력 캔버스에 바로 쓰면 겹친 아래 레이어까지 덮고, 불투명도도 무시된다.
   */
  createSkinCanvas?: () => Scratch | null;
}

export interface DrawResult {
  /** 가려야 했던 얼굴 수(보이는 영역과 겹친 것). */
  masksRequested: number;
  masksDrawn: number;
  /** 가리지 못한 이유. 비어 있지 않으면 이 프레임은 원본 얼굴이 보일 수 있다 — 내보내기는 실패로 끝내야 한다. */
  failures: string[];
}

let sharedScratch: Scratch | null = null;
let skinLayer: Scratch | null = null;
function defaultSkinLayer(): Scratch | null {
  if (skinLayer) return skinLayer;
  if (typeof document === 'undefined') return null;
  skinLayer = document.createElement('canvas');
  return skinLayer;
}
function defaultScratch(): Scratch | null {
  if (sharedScratch) return sharedScratch;
  if (typeof document !== 'undefined') sharedScratch = document.createElement('canvas');
  else if (typeof OffscreenCanvas !== 'undefined') sharedScratch = new OffscreenCanvas(1, 1);
  return sharedScratch;
}

function maskList(layer: DrawLayer, video: Video, opts: DrawOptions): FaceMask[] | null {
  if (!opts.masksAt) return layer.faceMasks ?? [];
  const planned = layer.faceMasks ?? [];
  const merge = (found: FaceMask[] | null): FaceMask[] | null => {
    if (found == null) return null;
    // 계획 시각과 실제 프레임 시각이 어긋나면 두 곳을 모두 가린다. 빈 목록만으로 원본 얼굴을 그리지 않는다.
    if (!planned.length) return found;
    if (!found.length) return planned;
    return [...found, ...planned];
  };
  const actual = opts.mediaTimeOf?.(layer.decoderKey ?? layer.sourceId, video) ?? null;
  if (actual != null) return merge(opts.masksAt(layer, actual));
  const now = typeof video.currentTime === 'number' ? video.currentTime : null;
  if (now == null) return planned.length ? planned : [];
  const atNow = opts.masksAt(layer, now);
  if (video.seeking) return atNow == null ? null : merge(atNow);
  return merge(atNow);
}

/**
 * 원본 화소에서 얼굴을 흐린 뒤 그 결과를 레이어와 같은 크롭·배치로 그린다.
 * 흐림은 얼굴 상자 안 원본 화소만 쓰므로 "원본을 먼저 흐리고 크롭" 과 같은 결과다(크롭이 얼굴 일부만 보여도 같다).
 */
function blurFaces(
  ctx: CanvasRenderingContext2D,
  video: Video,
  layer: DrawLayer,
  masks: readonly FaceMask[],
  geo: { sw: number; sh: number; sx: number; sy: number; sww: number; shh: number; dx: number; dy: number; dw: number; dh: number },
  opts: DrawOptions,
  result: DrawResult,
) {
  if (!masks.length) return;
  const { sw, sh, sx, sy, sww, shh, dx, dy, dw, dh } = geo;
  for (const mask of masks) {
    const mx0 = Math.max(0, mask.box.x * sw);
    const my0 = Math.max(0, mask.box.y * sh);
    const mx1 = Math.min(sw, (mask.box.x + mask.box.width) * sw);
    const my1 = Math.min(sh, (mask.box.y + mask.box.height) * sh);
    if (mx1 - mx0 < 1 || my1 - my0 < 1) continue;
    const ix0 = Math.max(mx0, sx);
    const iy0 = Math.max(my0, sy);
    const ix1 = Math.min(mx1, sx + sww);
    const iy1 = Math.min(my1, sy + shh);
    if (ix1 <= ix0 || iy1 <= iy0) continue; // 크롭 밖이라 화면에 안 나온다.
    result.masksRequested += 1;
    const scratch = (opts.createScratch ?? defaultScratch)();
    const sctx = scratch?.getContext('2d') ?? null;
    if (!scratch || !sctx) { result.failures.push('blur-canvas-unavailable'); continue; }
    const mw = mx1 - mx0;
    const mh = my1 - my0;
    const long = Math.max(mw, mh);
    const cw = Math.max(1, Math.round(FACE_BLUR_CELLS * mw / long));
    const ch = Math.max(1, Math.round(FACE_BLUR_CELLS * mh / long));
    try {
      if (scratch.width !== cw) scratch.width = cw;
      if (scratch.height !== ch) scratch.height = ch;
      sctx.imageSmoothingEnabled = true;
      sctx.clearRect(0, 0, cw, ch);
      sctx.drawImage(video, mx0, my0, mw, mh, 0, 0, cw, ch);
      const scaleX = dw / sww;
      const scaleY = dh / shh;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, dw, dh);
      ctx.clip();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        scratch as CanvasImageSource,
        ((ix0 - mx0) / mw) * cw, ((iy0 - my0) / mh) * ch, ((ix1 - ix0) / mw) * cw, ((iy1 - iy0) / mh) * ch,
        dx + (ix0 - sx) * scaleX, dy + (iy0 - sy) * scaleY, (ix1 - ix0) * scaleX, (iy1 - iy0) * scaleY,
      );
      ctx.restore();
      result.masksDrawn += 1;
    } catch (error) {
      result.failures.push(error instanceof Error ? error.message : 'blur-draw-failed');
    }
  }
}

/**
 * 피부는 레이어 캔버스에서 원본 크롭에 적용한 뒤 불투명도로 합성한다.
 * 캔버스가 없으면(단위 시험) 출력 버퍼에 직접 적용한다. 그 경로는 겹친 아래 레이어를 덮을 수 있다.
 * 반환 true 이면 레이어를 이미 합성했다.
 */
function paintSkinnedLayer(
  ctx: CanvasRenderingContext2D,
  video: Video,
  layer: DrawLayer,
  geo: { sw: number; sh: number; sx: number; sy: number; sww: number; shh: number; dx: number; dy: number; dw: number; dh: number },
  width: number,
  height: number,
  opts: DrawOptions,
): boolean {
  if (opts.skinMode === 'off' || !layer.skin) return false;
  const { sw, sh, sx, sy, sww, shh, dx, dy, dw, dh } = geo;
  const ix = Math.max(0, Math.floor(dx));
  const iy = Math.max(0, Math.floor(dy));
  const iw = Math.min(width - ix, Math.max(1, Math.round(dw)));
  const ih = Math.min(height - iy, Math.max(1, Math.round(dh)));
  if (iw <= 1 || ih <= 1) return false;
  const canvas = opts.createSkinCanvas ? opts.createSkinCanvas() : defaultSkinLayer();
  const lctx = canvas?.getContext('2d') ?? null;
  if (!canvas || !lctx || typeof lctx.getImageData !== 'function' || typeof lctx.putImageData !== 'function') return false;
  if (canvas.width !== iw) canvas.width = iw;
  if (canvas.height !== ih) canvas.height = ih;
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalAlpha = 1;
  lctx.clearRect(0, 0, iw, ih);
  lctx.drawImage(video, sx, sy, sww, shh, 0, 0, iw, ih);
  const image = lctx.getImageData(0, 0, iw, ih);
  const next = applySkinRgba(image.data, iw, ih, layer.skin.mask, layer.skin.adjust, layer.skin.face, (x, y) => ({
    x: (sx + ((x + 0.5) / iw) * sww) / sw,
    y: (sy + ((y + 0.5) / ih) * shh) / sh,
  }));
  image.data.set(next);
  lctx.putImageData(image, 0, 0);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, iw, ih, ix, iy, iw, ih);
  ctx.restore();
  return true;
}

/** 미리보기와 내보내기가 같은 샘플을 같은 순서로 그린다. 자막은 얼굴 블러 뒤에 그려 함께 흐려지지 않는다. */
export function drawTimelineSample(
  ctx: CanvasRenderingContext2D,
  sample: TimelineSample,
  videos: ReadonlyMap<string, Video>,
  width: number,
  height: number,
  opts: DrawOptions = {},
): DrawResult {
  const result: DrawResult = { masksRequested: 0, masksDrawn: 0, failures: [] };
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  for (const layer of sample.layers) {
    // 같은 원본의 두 시각이 겹치면 레이어마다 다른 디코더를 쓴다(clip-timeline 의 decoderKey).
    const video = videos.get(layer.decoderKey ?? layer.sourceId);
    const sw = video && 'videoWidth' in video ? video.videoWidth ?? 0 : 0;
    const sh = video && 'videoHeight' in video ? video.videoHeight ?? 0 : 0;
    if (!video || sw < 2 || sh < 2) {
      if (layer.faceMasks?.length || layer.zoomRhythm) result.failures.push('source-frame-missing');
      continue;
    }
    const sx = layer.sourceRect.x * sw;
    const sy = layer.sourceRect.y * sh;
    const sww = Math.max(1, layer.sourceRect.w * sw);
    const shh = Math.max(1, layer.sourceRect.h * sh);
    const dx = layer.destRect.x * width;
    const dy = layer.destRect.y * height;
    const dw = layer.destRect.w * width;
    const dh = layer.destRect.h * height;
    // 가릴 곳을 먼저 정한다. 그 프레임의 얼굴 위치를 모르면 레이어를 그리지 않는다(원본 얼굴을 잠깐이라도 보이지 않게).
    const masks = maskList(layer, video, opts);
    if (masks == null) { result.failures.push('mask-time-unknown'); continue; }
    const geo = { sw, sh, sx, sy, sww, shh, dx, dy, dw, dh };
    const skinned = paintSkinnedLayer(ctx, video, layer, geo, width, height, opts);
    if (!skinned) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      ctx.drawImage(video, sx, sy, sww, shh, dx, dy, dw, dh);
      ctx.restore();
      if (opts.skinMode !== 'off' && layer.skin) {
        const ix = Math.max(0, Math.floor(dx));
        const iy = Math.max(0, Math.floor(dy));
        const iw = Math.min(width - ix, Math.max(1, Math.round(dw)));
        const ih = Math.min(height - iy, Math.max(1, Math.round(dh)));
        if (iw > 1 && ih > 1 && typeof ctx.getImageData === 'function') {
          const image = ctx.getImageData(ix, iy, iw, ih);
          const next = applySkinRgba(image.data, iw, ih, layer.skin.mask, layer.skin.adjust, layer.skin.face, (x, y) => ({
            x: (sx + ((x + 0.5) / iw) * sww) / sw,
            y: (sy + ((y + 0.5) / ih) * shh) / sh,
          }));
          image.data.set(next);
          ctx.putImageData(image, ix, iy);
        }
      }
    }
    blurFaces(ctx, video, layer, masks, geo, opts, result);
  }
  for (const caption of sample.captions) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, caption.opacity));
    const style = caption.style as Partial<CaptionStyle>;
    drawCaption(ctx, width, height, {
      id: caption.id,
      start: 0,
      end: 1,
      text: caption.text,
      style,
    });
    ctx.restore();
  }
  return result;
}
