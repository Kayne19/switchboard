"""Per-utterance detection rate for a trained model, optionally through the training augmentations.

Usage: python evaluate-clips.py models/<name>.onnx <clip_dir> [--augment]

On a directory of the target word the rate is recall; on a directory of
something else it is the false-accept rate per utterance. It is one number
either way, so it is one script.

evaluate.py scores the single feature window the training run saved per clip,
which is what train.py's own recall reports. Deployment slides a window over
the whole utterance and wakes on any frame that crosses the threshold, so this
script runs the production path over each held-out clip and takes its highest
score. With --augment the clip first goes through openWakeWord's own
augmentation (room impulse responses and background noise down to -10 dB SNR),
which is the hardest condition the training data contains.
"""

import argparse
import json
import os
from pathlib import Path

import numpy as np
import scipy.io.wavfile
from openwakeword.data import augment_clips
from openwakeword.model import Model
from tqdm import tqdm

THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
CHUNK = 1280
PAD = np.zeros(16000, dtype=np.int16)


def clip_length(clips):
    """train.py's clip length: median duration rounded up, floor of two seconds."""
    durations = [len(scipy.io.wavfile.read(clip)[1]) for clip in clips]
    total = int(round(np.median(durations) / 1000) * 1000) + 12000
    return 32000 if total < 32000 or abs(total - 32000) <= 4000 else total


def peak_scores(model, name, clips_audio):
    """The production path: a padded clip streamed in 1280-sample chunks.

    openWakeWord's own `predict_clip` pads a second of silence onto each end,
    and that padding is not a convenience: the detector scores a window of 16
    embeddings, about 1.44 s, so an unpadded one-second clip never fills one
    window with the phrase and the trailing silence the model was trained on.
    A microphone stream always supplies that context. Dropping the padding
    understates recall by about twenty points, which is how a usable model was
    read as a failing one (see docs/wake-word-training.md).
    """
    for audio in clips_audio:
        model.reset()
        padded = np.concatenate((PAD, np.asarray(audio, dtype=np.int16), PAD))
        best = 0.0
        for start in range(0, len(padded) - CHUNK + 1, CHUNK):
            score = model.predict(padded[start:start + CHUNK])[name]
            best = max(best, float(score))
        yield best


def clean_audio(clips):
    for clip in clips:
        _, data = scipy.io.wavfile.read(clip)
        yield data.astype(np.int16)


def augmented_audio(clips, background_paths, rir_paths, batch_size=16):
    total_length = clip_length(clips)
    generator = augment_clips(
        [str(clip) for clip in clips], total_length=total_length,
        batch_size=batch_size, background_clip_paths=background_paths, RIR_paths=rir_paths,
    )
    for batch in generator:
        for row in batch:  # augment_clips already yields 16-bit PCM
            yield np.asarray(row, dtype=np.int16)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("clip_dir")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--augment", action="store_true")
    parser.add_argument("--background-dir", default="./audioset_16k")
    parser.add_argument("--rir-dir", default="./mit_rirs")
    parser.add_argument("--out")
    args = parser.parse_args()

    model = Model(wakeword_models=[args.model], inference_framework="onnx")
    name = next(iter(model.models))
    clips = sorted(Path(args.clip_dir).glob("*.wav"))
    if args.limit:
        clips = clips[: args.limit]

    if args.augment:
        backgrounds = [str(p) for p in Path(args.background_dir).glob("*.wav")]
        rirs = [str(p) for p in Path(args.rir_dir).glob("*.wav")]
        audio = augmented_audio(clips, backgrounds, rirs)
    else:
        audio = clean_audio(clips)

    peaks = np.array(list(tqdm(peak_scores(model, name, audio), total=len(clips),
                               desc=os.path.basename(args.model))))

    report = {
        "model": args.model,
        "clip_dir": args.clip_dir,
        "augmented": bool(args.augment),
        "n_clips": int(len(peaks)),
        "per_clip_detection_rate": [
            {"threshold": threshold, "detection_rate": float((peaks > threshold).mean())}
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
