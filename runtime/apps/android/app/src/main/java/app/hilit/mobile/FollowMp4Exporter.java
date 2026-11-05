/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Camera Mov — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Camera Mov", the author, and https://github.com/ccw00325-spec/HILiT_camera_mov when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·c4a17e5092db6f38·5f579b1f @license @preserve */
package app.hilit.mobile;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;
import java.io.File;
import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** GPU crop + codec export. Must be called on a worker, never the UI thread. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class FollowMp4Exporter {
    static final String HDR_OLD_DEVICE_MESSAGE =
        "이 기기(Android 10 미만)는 HDR 로 찍은 영상의 색을 맞춰 저장하지 못합니다. 카메라에서 HDR 을 끄고 찍은 영상으로 다시 해 주세요.";

    /**
     * HDR 원본은 항상 SDR(BT.709) H.264 로 톤매핑해 저장한다.
     *
     * Media3 기본값(HDR_MODE_KEEP_HDR)은 H.264 를 요청해도 HDR 이면 HEVC HDR 로 바꿔 저장하고,
     * HEVC HDR 인코더가 없는 기기에서만 톤매핑한다(1.9.3 TransformerUtil
     * getOutputMimeTypeAndHdrModeAfterFallback). 그래서 같은 영상이 기기마다 다른 형식·다른 색으로
     * 나왔다. OpenGL 톤매핑은 API 29+ 에서 기기 사이 결과가 가장 일정하다(Media3 문서).
     * SDR 원본에는 이 모드가 아무 일도 하지 않는다.
     */
    static int hdrModeFor(int sdk, boolean hdrSource) {
        if (hdrSource && sdk < 29) throw new IllegalStateException(HDR_OLD_DEVICE_MESSAGE);
        return Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL;
    }

    /** 첫 영상 트랙의 전달 함수가 HLG·PQ 인가. 읽지 못하면 SDR 로 본다(톤매핑 모드는 SDR 에 무해). */
    static boolean isHdrSource(Context context, Uri source) {
        android.media.MediaExtractor extractor = new android.media.MediaExtractor();
        try {
            extractor.setDataSource(context, source, null);
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                android.media.MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(android.media.MediaFormat.KEY_MIME);
                if (mime == null || !mime.startsWith("video/")) continue;
                return isHdrTransfer(format.containsKey(android.media.MediaFormat.KEY_COLOR_TRANSFER)
                    ? format.getInteger(android.media.MediaFormat.KEY_COLOR_TRANSFER) : -1);
            }
            return false;
        } catch (Exception e) {
            return false;
        } finally {
            extractor.release();
        }
    }

    static boolean isHdrTransfer(int transfer) {
        return transfer == android.media.MediaFormat.COLOR_TRANSFER_HLG
            || transfer == android.media.MediaFormat.COLOR_TRANSFER_ST2084;
    }

    static Uri export(Context context, Uri source, List<HighlightEngine.Segment> segments,
                      NativeTrackingEngine.Result tracking, Mp4TrimExporter.Progress progress) throws Exception {
        if (segments.isEmpty()) throw new IllegalArgumentException("내보낼 장면이 없습니다.");
        NativeFollowCamera camera = new NativeFollowCamera(tracking.camera());
        List<EditedMediaItem> items = new ArrayList<>();
        for (HighlightEngine.Segment s : segments) {
            if (!(s.end > s.start && s.start >= 0)) throw new IllegalArgumentException("잘못된 영상 구간입니다.");
            MediaItem item = new MediaItem.Builder().setUri(source).setClippingConfiguration(
                new MediaItem.ClippingConfiguration.Builder().setStartPositionMs(Math.round(s.start*1000))
                    .setEndPositionMs(Math.round(s.end*1000)).build()).build();
            items.add(new EditedMediaItem.Builder(item).setEffects(new Effects(Collections.emptyList(),
                Collections.singletonList(new FollowCameraEffect(camera, s.start)))).build());
        }
        Composition composition = new Composition.Builder(new EditedMediaItemSequence.Builder(items).build())
            .setHdrMode(hdrModeFor(android.os.Build.VERSION.SDK_INT, isHdrSource(context, source))).build();
        File temp = File.createTempFile("hilit-follow-", ".mp4", context.getCacheDir());
        // Transformer creates the path itself.
        if (!temp.delete()) throw new IllegalStateException("임시 파일을 준비하지 못했습니다.");
        HandlerThread thread = new HandlerThread("hilit-export"); thread.start();
        Handler handler = new Handler(thread.getLooper());
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Exception> failure = new AtomicReference<>();
        AtomicReference<Transformer> active = new AtomicReference<>();
        try {
            handler.post(() -> {
                try {
                    Transformer transformer = new Transformer.Builder(context.getApplicationContext())
                        .setLooper(thread.getLooper()).setVideoMimeType(MimeTypes.VIDEO_H264)
                        .addListener(new Transformer.Listener() {
                            @Override public void onCompleted(Composition c, ExportResult r) { done.countDown(); }
                            @Override public void onError(Composition c, ExportResult r, ExportException e) {
                                failure.set(e); done.countDown();
                            }
                        }).build();
                    active.set(transformer); transformer.start(composition, temp.getAbsolutePath());
                    handler.post(new Runnable() {
                        @Override public void run() {
                            if (done.getCount() == 0) return;
                            ProgressHolder p = new ProgressHolder();
                            if (transformer.getProgress(p) == Transformer.PROGRESS_STATE_AVAILABLE)
                                progress.onProgress(Math.min(95, p.progress * 95 / 100));
                            handler.postDelayed(this, 300);
                        }
                    });
                } catch (Exception e) { failure.set(e); done.countDown(); }
            });
            long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(30);
            while (!done.await(200, TimeUnit.MILLISECONDS)) {
                if (Thread.currentThread().isInterrupted()) {
                    Transformer running = active.get();
                    if (running != null) running.cancel();
                    throw new InterruptedException("Export cancelled");
                }
                if (System.nanoTime() > deadline) throw new IllegalStateException("영상 내보내기 시간이 초과되었습니다.");
            }
            if (failure.get() != null) throw failure.get();
            if (!temp.isFile() || temp.length() == 0) throw new IllegalStateException("출력 영상이 비어 있습니다.");
            File dir = new File(context.getFilesDir(), "results");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("앱 전용 결과 폴더를 만들지 못했습니다.");
            File dest = new File(dir, "HILIT-"+System.currentTimeMillis()+".mp4");
            try (FileInputStream in = new FileInputStream(temp);
                 java.io.FileOutputStream out = new java.io.FileOutputStream(dest)) {
                byte[] buffer = new byte[65536]; int n;
                while ((n = in.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                    out.write(buffer, 0, n);
                }
            } catch (Exception e) {
                if (dest.exists() && !dest.delete()) { /* keep going; the failure is the copy */ }
                throw e;
            }
            progress.onProgress(100);
            return Uri.fromFile(dest);
        } finally {
            handler.removeCallbacksAndMessages(null);
            handler.post(() -> {
                try { if (active.get() != null) active.get().cancel(); }
                finally { temp.delete(); thread.quitSafely(); }
            });
        }
    }
}
