/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Camera Mov — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Camera Mov", the author, and https://github.com/ccw00325-spec/HILiT_camera_mov when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·c4a17e5092db6f38·d4966a81 @license @preserve */
package app.hilit.mobile;

import android.graphics.Matrix;
import androidx.media3.effect.MatrixTransformation;

/** Same camera plan for preview and each clipped export item. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class FollowCameraEffect implements MatrixTransformation {
    private final NativeFollowCamera camera;
    private final double sourceStart;
    FollowCameraEffect(NativeFollowCamera camera, double sourceStart) {
        this.camera = camera; this.sourceStart = sourceStart;
    }
    @Override public Matrix getMatrix(long presentationTimeUs) {
        double[] c = camera.at(sourceStart + presentationTimeUs / 1_000_000d);
        float s = (float)(1 / c[2]);
        Matrix matrix = new Matrix();
        // NDC y grows upwards; source box y grows downwards.
        matrix.setValues(new float[]{s,0,(float)(-(2*c[0]-1)*s),
            0,s,(float)((2*c[1]-1)*s), 0,0,1});
        return matrix;
    }
}
