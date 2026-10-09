"""Evaluate a trained openWakeWord model across thresholds.

Usage: python evaluate.py models/<name>.onnx models/<name> [--out report.json]

Recall is measured on the held-out augmented positives the training run set
aside. False accepts per hour use the 11.3-hour openWakeWord validation
negatives, scored on every stride-1 window of 16 embeddings, which is the
denominator and the window count train.py's own metric uses.
"""

import argparse
import json

import numpy as np
import onnx
import onnxruntime as ort

VAL_SET_HOURS = 11.3
THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]
WINDOW = 16


def session_for(path):
    """The exported model fixes its batch size at 1; score it in batches."""
    model = onnx.load(path)
    model.graph.input[0].type.tensor_type.shape.dim[0].dim_param = "batch"
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    return ort.InferenceSession(
        model.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"]
    )


def scores(session, features, batch=4096):
    name = session.get_inputs()[0].name
    out = []
    for start in range(0, len(features), batch):
        chunk = np.ascontiguousarray(features[start:start + batch], dtype=np.float32)
        out.append(session.run(None, {name: chunk})[0].reshape(-1))
    return np.concatenate(out) if out else np.array([])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("feature_dir")
    parser.add_argument("--validation-negatives", default="validation_set_features.npy")
    parser.add_argument("--out")
    args = parser.parse_args()

    session = session_for(args.model)
    positives = np.load(f"{args.feature_dir}/positive_features_test.npy")
    adversarial = np.load(f"{args.feature_dir}/negative_features_test.npy")
    frames = np.load(args.validation_negatives)
    windows = np.lib.stride_tricks.sliding_window_view(frames, WINDOW, axis=0)
    windows = np.moveaxis(windows, -1, 1)

    positive_scores = scores(session, positives)
    adversarial_scores = scores(session, adversarial)
    negative_scores = scores(session, windows)

    report = {
        "model": args.model,
        "n_positive_heldout": int(len(positive_scores)),
        "n_adversarial_heldout": int(len(adversarial_scores)),
        "validation_negative_hours": VAL_SET_HOURS,
        "n_validation_windows": int(len(negative_scores)),
        "thresholds": [
            {
                "threshold": threshold,
                "recall": float((positive_scores > threshold).mean()),
                "adversarial_false_accept_rate": float((adversarial_scores > threshold).mean()),
                "false_accepts_per_hour": float((negative_scores > threshold).sum() / VAL_SET_HOURS),
            }
            for threshold in THRESHOLDS
        ],
    }
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text + "\n")


if __name__ == "__main__":
    main()
