#!/usr/bin/env python3
"""Offline pose-sample audit for the sports-dataset survey.

Reads a COCO-style 2D annotation file, a (T, J, 3) numpy sequence, or a
landing-point CSV. Writes summary JSON and, for pose inputs, an SVG stick
figure. Does not download data, does not import human3d, and does not write
runtime assets.

Joint layouts: only H36M-17 and COCO-17 are implemented, and any other joint
count is refused. For .npy input the layout is picked from bilateral bone
symmetry. When that check is not decisive the run stops unless --skeleton names
the layout; the report records symmetry_confidence and ambiguous either way. Use
--skeleton only when the source documents its joint order. COCO files count as
a temporal sequence only when each image has a numeric frame_index or
timestamp_s. Otherwise the order is a natural sort of file_name, and no motion
continuity is computed from it.

Stdlib + numpy only.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

# Human3.6M 17, the layout MotionBERT-style lifters usually emit.
# Index 0 is the pelvis. Bilateral long bones are the symmetry check.
H36M = [
    "pelvis", "rhip", "rknee", "rank", "lhip", "lknee", "lank",
    "spine", "thorax", "neck", "head", "lsho", "lelb", "lwri",
    "rsho", "relb", "rwri",
]
H36M_BONES = [
    ("pelvis-rhip", 0, 1), ("rhip-rknee", 1, 2), ("rknee-rank", 2, 3),
    ("pelvis-lhip", 0, 4), ("lhip-lknee", 4, 5), ("lknee-lank", 5, 6),
    ("pelvis-spine", 0, 7), ("spine-thorax", 7, 8), ("thorax-neck", 8, 9),
    ("neck-head", 9, 10), ("thorax-lsho", 8, 11), ("lsho-lelb", 11, 12),
    ("lelb-lwri", 12, 13), ("thorax-rsho", 8, 14), ("rsho-relb", 14, 15),
    ("relb-rwri", 15, 16),
]
H36M_PAIRS = [("rhip-rknee", "lhip-lknee"), ("rknee-rank", "lknee-lank"),
              ("rsho-relb", "lsho-lelb"), ("relb-rwri", "lelb-lwri")]
H36M_CHAIN = {
    "rknee": (1, 2, 3), "lknee": (4, 5, 6),
    "relbow": (14, 15, 16), "lelbow": (11, 12, 13),
}

# COCO 17. Index 0 is the nose, so a permanently zeroed joint 0 is unlikely.
COCO17_BONES = [
    ("lsho-rsho", 5, 6), ("lsho-lelb", 5, 7), ("lelb-lwri", 7, 9),
    ("rsho-relb", 6, 8), ("relb-rwri", 8, 10), ("lhip-rhip", 11, 12),
    ("lhip-lknee", 11, 13), ("lknee-lank", 13, 15), ("rhip-rknee", 12, 14),
    ("rknee-rank", 14, 16), ("lsho-lhip", 5, 11), ("rsho-rhip", 6, 12),
]
COCO17_PAIRS = [("lsho-lelb", "rsho-relb"), ("lelb-lwri", "relb-rwri"),
                ("lhip-lknee", "rhip-rknee"), ("lknee-lank", "rknee-rank")]


# Joint layouts this script knows. Anything else is refused.
SKELETON_CHOICES = ("auto", "h36m17", "coco17")
# Symmetry gate for the auto pick, on mean |log(left/right)| over the L/R pairs.
# Auto needs the best layout within SYM_MAX_ERR and a margin of SYM_MIN_MARGIN.
# "high" confidence needs the stricter SYM_HIGH_* bars. These numbers were set by
# looking at the three committed .npy samples; they are not a validity test.
SYM_MAX_ERR = 0.15
SYM_MIN_MARGIN = 0.20
SYM_HIGH_ERR = 0.10
SYM_HIGH_MARGIN = 0.25
# Keys that make a COCO image order a verified temporal order.
TEMPORAL_KEYS = ("frame_index", "timestamp_s")


def _f(x) -> float:
    return float(x)


def _round(x, n=4):
    if x is None:
        return None
    return round(float(x), n)


def bone_table(seq: np.ndarray, bones):
    rows = []
    for name, i, j in bones:
        d = np.linalg.norm(seq[:, i] - seq[:, j], axis=-1)
        mean = float(d.mean())
        cv = float(d.std() / mean) if mean > 1e-8 else None
        rows.append({
            "bone": name,
            "mean": _round(mean, 4),
            "min": _round(d.min(), 4),
            "max": _round(d.max(), 4),
            "cv": _round(cv, 4) if cv is not None else None,
        })
    return rows


def symmetry(rows, pairs):
    by = {r["bone"]: r["mean"] for r in rows}
    out = []
    for a, b in pairs:
        va, vb = by.get(a), by.get(b)
        if not va or not vb:
            continue
        ratio = va / vb
        out.append({"left_right": [a, b], "ratio": _round(ratio, 3)})
    return out


def median_cv(rows):
    cvs = [r["cv"] for r in rows if r["cv"] is not None]
    return float(np.median(cvs)) if cvs else None


def interior_angle(a, b, c):
    """Unsigned angle at b, degrees. 180 is straight; 0 is fully folded."""
    u = a - b
    v = c - b
    un = np.linalg.norm(u, axis=-1)
    vn = np.linalg.norm(v, axis=-1)
    cos = np.clip((u * v).sum(-1) / (un * vn + 1e-8), -1, 1)
    return np.degrees(np.arccos(cos))


def step_stats(seq, index):
    step = np.linalg.norm(np.diff(seq[:, index], axis=0), axis=-1)
    if step.size == 0:
        return None
    return {
        "median": _round(np.median(step)),
        "p95": _round(np.percentile(step, 95)),
        "max": _round(step.max()),
    }


def choose_topology(seq, requested: str = "auto"):
    """Choose the joint layout for a (T, J, 3) array.

    Only the two 17-joint layouts are implemented. The heuristic compares each
    layout's bilateral long-bone symmetry (mean |log(left/right)| over its L/R
    pairs), then bone-length CV. It measures the array. It does not read the
    file header and does not verify joint order. A layout passed by the caller
    is recorded as source "caller" and skips the gate.
    """
    if requested not in SKELETON_CHOICES:
        raise SystemExit(f"unknown skeleton {requested!r}; choose from {SKELETON_CHOICES}")
    joints = seq.shape[1]
    if joints != 17:
        return {
            "chosen": None,
            "source": None,
            "symmetry_confidence": None,
            "ambiguous": None,
            "heuristic_pick": None,
            "reason": f"{joints} joints: no layout is implemented (only H36M-17 and COCO-17 are)",
            "warning": None,
        }
    h_rows = bone_table(seq, H36M_BONES)
    c_rows = bone_table(seq, COCO17_BONES)

    def sym_err(rows, pairs):
        ratios = [abs(np.log(r["ratio"])) for r in symmetry(rows, pairs) if r["ratio"]]
        return float(np.mean(ratios)) if ratios else 99.0

    h_err, c_err = sym_err(h_rows, H36M_PAIRS), sym_err(c_rows, COCO17_PAIRS)
    h_cv, c_cv = median_cv(h_rows), median_cv(c_rows)
    heuristic = "h36m17" if (h_err, h_cv or 99) <= (c_err, c_cv or 99) else "coco17"
    best_err, margin = min(h_err, c_err), abs(h_err - c_err)
    ambiguous = best_err > SYM_MAX_ERR or margin < SYM_MIN_MARGIN
    if ambiguous:
        confidence = "low"
    elif margin >= SYM_HIGH_MARGIN and best_err <= SYM_HIGH_ERR:
        confidence = "high"
    else:
        confidence = "medium"
    warning = None
    if requested != "auto":
        chosen, source, reason = requested, "caller", "layout set by --skeleton"
        notes = []
        if ambiguous:
            notes.append("symmetry check is ambiguous for this array")
        elif requested != heuristic:
            notes.append(f"symmetry check prefers {heuristic}")
        warning = "; ".join(notes) or None
    elif ambiguous:
        chosen, source = None, None
        reason = (
            f"ambiguous joint layout (best symmetry error {best_err:.3f}, margin {margin:.3f}); "
            "pass --skeleton h36m17 or coco17 only if the source documents its joint order"
        )
    else:
        chosen, source, reason = heuristic, "auto", None
    return {
        "chosen": chosen,
        "source": source,
        "symmetry_confidence": confidence,
        "ambiguous": ambiguous,
        "heuristic_pick": heuristic,
        "reason": reason,
        "warning": warning,
        "margin_logerr": _round(margin, 4),
        "h36m_symmetry_logerr": _round(h_err, 4),
        "coco17_symmetry_logerr": _round(c_err, 4),
        "h36m_median_cv": _round(h_cv, 4),
        "coco17_median_cv": _round(c_cv, 4),
    }


def up_axis(seq, head, ankle_a, ankle_b):
    delta = seq[:, head].mean(0) - 0.5 * (seq[:, ankle_a] + seq[:, ankle_b]).mean(0)
    axis = int(np.argmax(np.abs(delta)))
    sign = 1.0 if delta[axis] >= 0 else -1.0
    return axis, sign, [_round(v, 4) for v in delta]


def audit_npy(seq: np.ndarray, fps: float | None, height_cm: float | None, label: str,
              skeleton: str = "auto"):
    seq = np.asarray(seq, dtype=float)
    if seq.ndim != 3 or seq.shape[-1] != 3:
        raise SystemExit(f"{label}: expected (T, J, 3), got {seq.shape}")
    topo = choose_topology(seq, skeleton)
    if topo["chosen"] is None:
        raise SystemExit(f"{label}: {topo['reason']}")
    if topo["warning"]:
        print(f"{label}: warning: {topo['warning']}", file=sys.stderr)
    use_h36m = topo["chosen"] == "h36m17"
    bones = H36M_BONES if use_h36m else COCO17_BONES
    rows = bone_table(seq, bones)
    head, ank_a, ank_b, pelvis = (10, 3, 6, 0) if use_h36m else (0, 15, 16, 11)
    # COCO-17 has no single pelvis; use the hip midpoint as a virtual joint.
    if use_h36m:
        axis, sign, delta = up_axis(seq, head, ank_a, ank_b)
        pel = seq[:, pelvis]
        ank = np.stack([seq[:, ank_a, axis], seq[:, ank_b, axis]], axis=1) * sign
    else:
        hip = 0.5 * (seq[:, 11] + seq[:, 12])
        # up-axis from nose vs ankles
        delta_v = seq[:, 0].mean(0) - 0.5 * (seq[:, 15] + seq[:, 16]).mean(0)
        axis = int(np.argmax(np.abs(delta_v)))
        sign = 1.0 if delta_v[axis] >= 0 else -1.0
        delta = [_round(v, 4) for v in delta_v]
        pel = hip
        ank = np.stack([seq[:, 15, axis], seq[:, 16, axis]], axis=1) * sign
    lower = ank.min(axis=1)
    pel_up = pel[:, axis] * sign
    height = float((seq[:, head, axis] * sign - lower).mean())
    root_xy_max = float(np.max(np.abs(seq[:, 0, :2]))) if use_h36m else None
    angles = {}
    if use_h36m:
        for name, (i, j, k) in H36M_CHAIN.items():
            deg = interior_angle(seq[:, i], seq[:, j], seq[:, k])
            flex = 180.0 - deg
            angles[name] = {
                "interior_min": _round(deg.min(), 1),
                "interior_max": _round(deg.max(), 1),
                "flexion_max": _round(flex.max(), 1),
            }
    horiz = [k for k in range(3) if k != axis]
    if use_h36m and len(horiz) == 2:
        sh = seq[:, 14][:, horiz] - seq[:, 11][:, horiz]
        yaw = np.unwrap(np.arctan2(sh[:, 1], sh[:, 0]))
        yaw_step = np.abs(np.diff(yaw)) if yaw.size > 1 else np.array([0.0])
        yaw_info = {
            "span_deg": _round(np.ptp(yaw) * 180 / np.pi, 1),
            "max_step_deg": _round(yaw_step.max() * 180 / np.pi, 1),
        }
    else:
        yaw_info = None
    steps = {}
    names = H36M if use_h36m else [str(i) for i in range(seq.shape[1])]
    for name, i in (("pelvis_or_j0", 0), ("joint_r_wrist", 16 if use_h36m else 10),
                    ("joint_r_ankle", 3 if use_h36m else 16)):
        steps[name] = step_stats(seq, i)
    scale_note = None
    if height_cm and height > 1e-6:
        scale_note = {
            "metadata_height_m": _round(height_cm / 100, 3),
            "skeleton_head_to_lower_ankle_m": _round(height, 3),
            "ratio_metadata_over_skeleton": _round((height_cm / 100) / height, 3),
        }
    return {
        "label": label,
        "shape": list(seq.shape),
        "dtype_note": "parsed as float",
        "coord_min": _round(seq.min(), 4),
        "coord_max": _round(seq.max(), 4),
        "fps": fps,
        "duration_s": _round(seq.shape[0] / fps, 4) if fps else None,
        "topology": topo,
        "joint0_xy_abs_max": _round(root_xy_max, 6),
        "up_axis": axis,
        "up_sign": sign,
        "head_minus_ankle": delta,
        "lower_ankle_up_abs_max": _round(np.max(np.abs(lower)), 6),
        "lower_ankle_pinned_near_zero": bool(np.max(np.abs(lower)) < 1e-3),
        "pelvis_up_min": _round(pel_up.min(), 4),
        "pelvis_up_max": _round(pel_up.max(), 4),
        "pelvis_up_range": _round(pel_up.max() - pel_up.min(), 4),
        "other_ankle_clearance_max": _round((ank.max(axis=1) - lower).max(), 4),
        "skeleton_height": _round(height, 4),
        "scale_vs_metadata": scale_note,
        "bones": rows,
        "bone_median_cv": _round(median_cv(rows), 4),
        "symmetry": symmetry(rows, H36M_PAIRS if use_h36m else COCO17_PAIRS),
        "angles_deg": angles,
        "shoulder_yaw": yaw_info,
        "frame_steps": steps,
        "joint_names_if_h36m": H36M if use_h36m else None,
    }, seq, bones, axis, sign


def jpeg_size(path: Path):
    data = path.read_bytes()
    i = 2
    while i < len(data) - 8:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return int(w), int(h)
        if marker == 0xD8 or marker == 0xD9:
            i += 2
            continue
        if i + 4 > len(data):
            break
        seg = struct.unpack(">H", data[i + 2:i + 4])[0]
        i += 2 + seg
    return None


def natural_key(text: str):
    """Sort key that compares embedded digit runs by value, so T_2 sorts before T_10."""
    return [int(t) if i % 2 else t for i, t in enumerate(re.split(r"(\d+)", text))]


def order_images(images: list):
    """Return (ordered, basis). basis is the temporal key used, or None.

    A temporal order is used only when every image has a unique numeric
    frame_index or timestamp_s. Otherwise the order is a natural sort of
    file_name, which orders labels and nothing more.
    """
    for key in TEMPORAL_KEYS:
        vals = [im.get(key) for im in images]
        numeric = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals)
        if images and numeric and len(set(vals)) == len(vals):
            return sorted(images, key=lambda im: im[key]), key
    ordered = sorted(images, key=lambda im: (natural_key(im.get("file_name") or ""), im.get("id", 0)))
    return ordered, None


def audit_coco(doc: dict, fps: float | None, label: str, image: Path | None, jump_px: float):
    cats = doc.get("categories") or []
    if not cats:
        raise SystemExit(f"{label}: no categories")
    names = cats[0].get("keypoints") or []
    images = {im["id"]: im for im in doc.get("images") or []}
    anns = {}
    for ann in doc.get("annotations") or []:
        anns.setdefault(ann["image_id"], ann)
    ordered, order_key = order_images(list(images.values()))
    temporal_verified = order_key is not None
    pts, vis, outside = [], [], 0
    wh = {(im.get("width"), im.get("height")) for im in ordered}
    for im in ordered:
        ann = anns.get(im["id"])
        if ann is None:
            continue
        arr = np.array(ann["keypoints"], dtype=float).reshape(-1, 3)
        pts.append(arr[:, :2])
        vis.append(arr[:, 2])
        w, h = im.get("width") or 0, im.get("height") or 0
        if w and h:
            xy = arr[:, :2]
            outside += int(((xy[:, 0] < 0) | (xy[:, 0] > w) | (xy[:, 1] < 0) | (xy[:, 1] > h)).sum())
    pts = np.stack(pts)
    vis = np.stack(vis)
    idx = {n: i for i, n in enumerate(names)}
    # Per consecutive pair in the order used: median over joints of the xy step.
    jump = np.median(np.linalg.norm(np.diff(pts, axis=0), axis=-1), axis=1)

    def segment_pose(s, e):
        need = ["left_hip", "right_hip", "left_shoulder", "right_shoulder"]
        if any(n not in idx for n in need):
            return None
        hip_y = 0.5 * (pts[s:e, idx["left_hip"], 1] + pts[s:e, idx["right_hip"], 1])
        sho_y = 0.5 * (pts[s:e, idx["left_shoulder"], 1] + pts[s:e, idx["right_shoulder"], 1])
        torso = np.median(np.abs(sho_y - hip_y))
        return {
            "start": int(s),
            "length": int(e - s),
            "hip_y_range_px": _round(hip_y.max() - hip_y.min(), 2),
            "torso_px": _round(torso, 2),
            "hip_y_range_over_torso": _round((hip_y.max() - hip_y.min()) / torso, 3) if torso else None,
        }

    def split_segments(thr):
        cuts_at = np.where(jump > thr)[0]
        bounds_at = [0] + (cuts_at + 1).tolist() + [pts.shape[0]]
        segs_at = []
        for s, e in zip(bounds_at[:-1], bounds_at[1:]):
            row = segment_pose(int(s), int(e)) if e - s >= 10 else None
            if row:
                segs_at.append(row)
        return cuts_at, np.diff(bounds_at), segs_at

    def sensitivity_row(thr):
        cuts_at, lengths, segs = split_segments(thr)
        ratios = [s["hip_y_range_over_torso"] for s in segs if s["hip_y_range_over_torso"] is not None]
        return {
            "threshold_px": thr,
            "n_cuts": int(cuts_at.size),
            "segment_count": int(lengths.size),
            "segment_length_min_median_max": [int(lengths.min()), _round(np.median(lengths), 1), int(lengths.max())],
            "hip_range_over_torso_median": _round(np.median(ratios), 3) if ratios else None,
            "n_segments_len_ge_10": len(segs),
        }

    # Motion claims need a verified frame order; otherwise this stays None.
    continuous_motion = None
    if temporal_verified:
        cuts_at, lengths, segs = split_segments(jump_px)
        ratios = [s["hip_y_range_over_torso"] for s in segs if s["hip_y_range_over_torso"] is not None]
        continuous_motion = {
            "cut_threshold_px": jump_px,
            "n_cuts": int(cuts_at.size),
            "segment_count": int(lengths.size),
            "segment_length_min_median_max": [int(lengths.min()), _round(np.median(lengths), 1), int(lengths.max())],
            "segments_len_ge_10": segs,
            "hip_range_over_torso_median": _round(np.median(ratios), 3) if ratios else None,
            "hip_range_over_torso_max": _round(np.max(ratios), 3) if ratios else None,
            "longest_stable_segment": max(segs, key=lambda s: s["length"]) if segs else None,
            "jump_sensitivity": [sensitivity_row(thr) for thr in (40, 80, 120)],
        }
    # Diagnostic for the order used. Large steps here are label jumps unless the order is verified.
    sorted_neighbor_jumps = {
        "definition": "consecutive pairs in the order used; median over joints of xy step, px",
        "threshold_px": jump_px,
        "count_over_threshold": int((jump > jump_px).sum()),
        "median_px": _round(np.median(jump), 2) if jump.size else None,
        "p90_px": _round(np.percentile(jump, 90), 2) if jump.size else None,
        "sensitivity": [
            {"threshold_px": thr, "count_over_threshold": int((jump > thr).sum())}
            for thr in (40, 80, 120)
        ],
    }
    bones = []
    torso_len = None
    if all(n in idx for n in ("left_shoulder", "right_shoulder", "left_hip", "right_hip")):
        sho = 0.5 * (pts[:, idx["left_shoulder"]] + pts[:, idx["right_shoulder"]])
        hip = 0.5 * (pts[:, idx["left_hip"]] + pts[:, idx["right_hip"]])
        torso_len = np.linalg.norm(sho - hip, axis=-1)
    pairs = [
        ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
        ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
        ("left_hip", "left_knee"), ("left_knee", "left_ankle"),
        ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
        ("left_shoulder", "right_shoulder"), ("left_hip", "right_hip"),
        ("left_shoulder", "neck"), ("neck", "nose"),
    ]
    for a, b in pairs:
        if a not in idx or b not in idx:
            continue
        m = (vis[:, idx[a]] > 0) & (vis[:, idx[b]] > 0)
        if m.sum() < 2:
            continue
        d = np.linalg.norm(pts[m, idx[a]] - pts[m, idx[b]], axis=-1)
        row = {
            "bone": f"{a}-{b}",
            "n": int(m.sum()),
            "mean_px": _round(d.mean(), 2),
            "cv": _round(d.std() / d.mean(), 3),
        }
        if torso_len is not None:
            ratio = d / np.maximum(torso_len[m], 1e-6)
            row["torso_normalized_cv"] = _round(ratio.std() / ratio.mean(), 3)
        bones.append(row)
    image_check = None
    if image is not None:
        size = jpeg_size(image)
        image_check = {"path": image.name, "jpeg_wh": list(size) if size else None}
    order_note = (
        f"ordered by {order_key} in the file" if temporal_verified else
        "ordered by natural sort of file_name: labels only, not verified as video time; "
        "no motion continuity is computed"
    )
    return {
        "label": label,
        "category": cats[0].get("name"),
        "keypoint_names": names,
        "n_images": len(ordered),
        "n_annotations_used": int(pts.shape[0]),
        "image_wh": [list(x) for x in wh],
        "keypoints_outside_frame": int(outside),
        "visibility_counts": {str(int(v)): int((vis == v).sum()) for v in np.unique(vis)},
        "missing_rate_per_joint": {
            n: _round((vis[:, i] == 0).mean(), 4) for n, i in idx.items()
        },
        "temporal_order_verified": temporal_verified,
        "order_basis": order_key or "file_name_natural_sort",
        "order_note": order_note,
        "sorted_neighbor_jumps": sorted_neighbor_jumps,
        "continuous_motion": continuous_motion,
        "bones_px": bones,
        "fps_assumed": fps,
        "image_file_check": image_check,
        "ground_plane": False,
        "units": "pixels",
    }, pts, names


def audit_csv(path: Path):
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return {"file": path.name, "n": 0}
    side_key = "To-Closest-Doubles-Sideline-Distance (m)"
    base_key = "To-Baseline-Distance (m)"
    side = np.array([float(r[side_key]) for r in rows])
    base = np.array([float(r[base_key]) for r in rows])
    return {
        "file": path.name,
        "n": len(rows),
        "columns": list(rows[0].keys()),
        "sideline_m": {"min": _round(side.min(), 3), "max": _round(side.max(), 3)},
        "baseline_m": {"min": _round(base.min(), 3), "max": _round(base.max(), 3)},
        "negative_baseline_count": int((base < 0).sum()),
        "negative_sideline_count": int((side < 0).sum()),
        "pose_keypoints": False,
    }


def stick_svg(frames, bones, project, title, path: Path, caption: str = "frame"):
    """frames: list of (J, D) arrays. project(frame) -> (J, 2) with y up.

    Each panel is scaled on its own so a player who translates across the
    image does not shrink the pose to a corner.
    """
    projected = [project(fr) for fr in frames]
    pad = 24
    panel_w, panel_h = 280, 320
    gap = 16
    width = pad * 2 + len(frames) * panel_w + (len(frames) - 1) * gap
    height = pad * 2 + panel_h + 36
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#f7f4ee"/>',
        f'<text x="{pad}" y="22" font-family="ui-sans-serif,sans-serif" font-size="14" fill="#222">{_xml(title)}</text>',
    ]
    for n, xy in enumerate(projected):
        ox = pad + n * (panel_w + gap)
        oy = 36
        min_xy = xy.min(0)
        span = np.maximum(xy.max(0) - min_xy, 1e-6)
        scale = min((panel_w - 28) / span[0], (panel_h - 36) / span[1])
        def pix(p, min_xy=min_xy, scale=scale):
            x = ox + 14 + (p[0] - min_xy[0]) * scale
            y = oy + panel_h - 14 - (p[1] - min_xy[1]) * scale
            return x, y
        parts.append(
            f'<rect x="{ox}" y="{oy}" width="{panel_w}" height="{panel_h}" '
            'fill="#fff" stroke="#ddd"/>'
        )
        for i, j in bones:
            x1, y1 = pix(xy[i])
            x2, y2 = pix(xy[j])
            parts.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                'stroke="#24342a" stroke-width="2"/>'
            )
        for point in xy:
            x, y = pix(point)
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="#b4532a"/>')
        parts.append(
            f'<text x="{ox + 8}" y="{oy + 16}" font-family="ui-sans-serif,sans-serif" '
            f'font-size="12" fill="#555">{_xml(caption)} {n + 1}/{len(frames)} · own scale</text>'
        )
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


def _xml(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def project_3d(axis, sign):
    def project(frame):
        # horizontal: axis 0. vertical: detected up axis, sign so the head is positive.
        horiz = 0 if axis != 0 else 1
        return np.stack([frame[:, horiz], frame[:, axis] * sign], axis=1)
    return project


def project_2d():
    def project(frame):
        # image y grows downward; flip so the head is up in the SVG
        return np.stack([frame[:, 0], -frame[:, 1]], axis=1)
    return project


def bone_index_pairs(bones):
    return [(i, j) for _name, i, j in bones]


def selftest():
    rng = np.random.default_rng(0)
    t = 40
    # Rigid standing H36M skeleton, metres, z up, pelvis drifting in x.
    rest = np.zeros((17, 3))
    rest[0] = (0, 0, 0.95)
    rest[1] = (0.10, 0, 0.95)
    rest[2] = (0.10, 0, 0.52)
    rest[3] = (0.10, 0.02, 0.08)
    rest[4] = (-0.10, 0, 0.95)
    rest[5] = (-0.10, 0, 0.52)
    rest[6] = (-0.10, 0.02, 0.08)
    rest[7] = (0, 0, 1.10)
    rest[8] = (0, 0, 1.32)
    rest[9] = (0, 0, 1.48)
    rest[10] = (0, 0, 1.62)
    rest[11] = (-0.18, 0, 1.32)
    rest[12] = (-0.18, 0, 1.05)
    rest[13] = (-0.18, 0, 0.80)
    rest[14] = (0.18, 0, 1.32)
    rest[15] = (0.18, 0, 1.05)
    rest[16] = (0.18, 0, 0.80)
    seq = np.repeat(rest[None], t, axis=0)
    seq[:, :, 0] += np.linspace(0, 0.4, t)[:, None]
    seq += rng.normal(0, 0.0005, seq.shape)
    report, _, _, axis, sign = audit_npy(seq, fps=60, height_cm=178, label="rigid")
    topo = report["topology"]
    assert topo["chosen"] == "h36m17" and topo["source"] == "auto", topo
    assert topo["symmetry_confidence"] == "high" and topo["ambiguous"] is False, topo
    assert axis == 2 and sign == 1
    assert report["bone_median_cv"] < 0.02, report["bone_median_cv"]
    assert report["lower_ankle_pinned_near_zero"] is False
    assert report["scale_vs_metadata"]["ratio_metadata_over_skeleton"] < 1.3

    pinned = seq.copy()
    lower = np.minimum(pinned[:, 3, 2], pinned[:, 6, 2])
    pinned[:, :, 2] -= lower[:, None]
    pinned[:, 0, 0] = 0
    pinned[:, 0, 1] = 0
    pinned_report, _, _, _, _ = audit_npy(pinned, fps=60, height_cm=None, label="pinned")
    assert pinned_report["lower_ankle_pinned_near_zero"] is True
    assert pinned_report["joint0_xy_abs_max"] == 0

    # Joint counts other than 17 are refused, whatever --skeleton says.
    other = np.random.default_rng(1)
    for joints in (16, 55, 86):
        bad = other.normal(0, 0.5, (5, joints, 3))
        for skeleton in ("auto", "h36m17", "coco17"):
            topo = choose_topology(bad, skeleton)
            assert topo["chosen"] is None and f"{joints} joints" in topo["reason"], topo
            try:
                audit_npy(bad, fps=60, height_cm=None, label="bad", skeleton=skeleton)
            except SystemExit as exc:
                assert f"{joints} joints" in str(exc), str(exc)
            else:
                raise AssertionError(f"{joints} joints accepted with skeleton={skeleton}")

    # Structureless joints: the L/R symmetry check cannot separate the layouts,
    # so auto refuses and an explicit layout is recorded with low symmetry confidence.
    noise = rng.normal(0, 1.0, (t, 17, 3))
    topo = choose_topology(noise)
    assert topo["chosen"] is None and topo["ambiguous"] is True, topo
    assert topo["symmetry_confidence"] == "low", topo
    forced, _, _, _, _ = audit_npy(noise, fps=60, height_cm=None, label="noise", skeleton="h36m17")
    assert forced["topology"]["source"] == "caller" and forced["topology"]["ambiguous"] is True
    assert forced["topology"]["symmetry_confidence"] == "low", forced["topology"]

    # Per-frame jitter does not change the symmetry pick, but it shows in bone CV.
    rubber = seq + rng.normal(0, 0.08, seq.shape)
    rubber_report, _, _, _, _ = audit_npy(rubber, fps=60, height_cm=None, label="rubber", skeleton="h36m17")
    assert rubber_report["bone_median_cv"] > 0.05, rubber_report["bone_median_cv"]

    # Natural order by file_name; frame_index overrides it when present.
    ordered, basis = order_images([
        {"id": 0, "file_name": "T_10.jpeg"}, {"id": 1, "file_name": "T_2.jpeg"},
        {"id": 2, "file_name": "T_1.jpeg"},
    ])
    assert [im["file_name"] for im in ordered] == ["T_1.jpeg", "T_2.jpeg", "T_10.jpeg"], ordered
    assert basis is None
    by_frame, basis = order_images([
        {"id": 0, "file_name": "z.jpeg", "frame_index": 2},
        {"id": 1, "file_name": "a.jpeg", "frame_index": 0},
        {"id": 2, "file_name": "m.jpeg", "frame_index": 1},
    ])
    assert [im["id"] for im in by_frame] == [1, 2, 0] and basis == "frame_index"

    # 2D: two still clusters far apart give a neighbour jump. Only a verified
    # frame order turns that into a motion segmentation.
    def toy_doc(timed: bool):
        doc = {
            "categories": [{
                "name": "toy",
                "keypoints": [
                    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
                    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
                    "left_wrist", "right_wrist", "left_hip", "right_hip",
                    "left_knee", "right_knee", "left_ankle", "right_ankle", "neck",
                ],
            }],
            "images": [],
            "annotations": [],
        }
        for n in range(12):
            base = 0 if n < 6 else 400
            kpts = []
            for j in range(18):
                kpts += [100 + base + j, 80 + n + j * 3, 2]
            image = {"id": n, "file_name": f"T_{n:03d}.jpeg", "width": 1280, "height": 720}
            if timed:
                image["frame_index"] = n
            doc["images"].append(image)
            doc["annotations"].append({"image_id": n, "keypoints": kpts, "num_keypoints": 18})
        return doc

    untimed, _, _ = audit_coco(toy_doc(False), fps=30, label="toy", image=None, jump_px=80)
    assert untimed["temporal_order_verified"] is False and untimed["continuous_motion"] is None, untimed
    assert untimed["sorted_neighbor_jumps"]["count_over_threshold"] >= 1, untimed["sorted_neighbor_jumps"]
    assert untimed["keypoints_outside_frame"] == 0
    timed, _, _ = audit_coco(toy_doc(True), fps=30, label="toy_timed", image=None, jump_px=80)
    assert timed["temporal_order_verified"] is True and timed["order_basis"] == "frame_index", timed
    assert timed["continuous_motion"]["segment_count"] == 2, timed["continuous_motion"]
    print("selftest ok")
    return 0


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("selftest")
    s.set_defaults(func=lambda _a: selftest())

    n = sub.add_parser("npy")
    n.add_argument("path", type=Path)
    n.add_argument("--fps", type=float, default=None)
    n.add_argument("--height-cm", type=float, default=None)
    n.add_argument("--label", default=None)
    n.add_argument("--out", type=Path, required=True)
    n.add_argument("--skeleton", choices=SKELETON_CHOICES, default="auto",
                   help="joint layout; auto refuses arrays whose layout is ambiguous")
    n.set_defaults(func=cmd_npy)

    c = sub.add_parser("coco")
    c.add_argument("path", type=Path)
    c.add_argument("--fps", type=float, default=None)
    c.add_argument("--image", type=Path, default=None)
    c.add_argument("--jump-px", type=float, default=80)
    c.add_argument("--label", default=None)
    c.add_argument("--out", type=Path, required=True)
    c.set_defaults(func=cmd_coco)

    v = sub.add_parser("csv")
    v.add_argument("path", type=Path)
    v.add_argument("--out", type=Path, required=True)
    v.set_defaults(func=cmd_csv)

    args = p.parse_args(argv)
    return args.func(args)


def cmd_npy(args):
    seq = np.load(args.path)
    label = args.label or args.path.stem
    report, seq, bones, axis, sign = audit_npy(seq, args.fps, args.height_cm, label, args.skeleton)
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / f"{label}.json", report)
    frames = [seq[0], seq[len(seq) // 2], seq[-1]]
    pairs = bone_index_pairs(bones)
    stick_svg(frames, pairs, project_3d(axis, sign), label, out / f"{label}.svg")
    topo = report["topology"]
    print(f"wrote {label}: topology={topo['chosen']} source={topo['source']} "
          f"symmetry_confidence={topo['symmetry_confidence']} median_cv={report['bone_median_cv']} "
          f"pelvis_up_range={report['pelvis_up_range']} "
          f"pinned={report['lower_ankle_pinned_near_zero']}")
    return 0


def cmd_coco(args):
    doc = json.loads(args.path.read_text(encoding="utf-8"))
    label = args.label or args.path.stem
    report, pts, names = audit_coco(doc, args.fps, label, args.image, args.jump_px)
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / f"{label}.json", report)
    # Motion frames only when the order is verified; otherwise a sorted sample.
    cm = report["continuous_motion"]
    seg = cm["longest_stable_segment"] if cm else None
    if seg:
        s = seg["start"]
        e = s + seg["length"] - 1
        frames = [pts[s], pts[(s + e) // 2], pts[e]]
    else:
        frames = [pts[0], pts[len(pts) // 2], pts[-1]]
    caption = "frame" if report["temporal_order_verified"] else "sorted sample"
    sk = doc["categories"][0].get("skeleton") or []
    pairs = [(a - 1, b - 1) for a, b in sk]
    stick_svg(frames, pairs, project_2d(), label, out / f"{label}.svg", caption)
    print(f"wrote {label}: images={report['n_images']} order={report['order_basis']} "
          f"neighbor_jumps>{args.jump_px:g}px={report['sorted_neighbor_jumps']['count_over_threshold']} "
          f"continuous_motion={'yes' if cm else 'no'}")
    return 0


def cmd_csv(args):
    report = audit_csv(args.path)
    label = args.path.stem
    args.out.mkdir(parents=True, exist_ok=True)
    write_json(args.out / f"{label}.json", report)
    print(f"wrote {label}: n={report['n']} neg_baseline={report.get('negative_baseline_count')}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
