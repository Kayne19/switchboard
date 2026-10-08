"""Generate a directory of Piper clips for one or more phrases, to score a model on.

Usage: WORKDIR=~/wakeword-training training/wake-words/generate-clips.py \
           <out_dir> <n_samples> <phrase> [<phrase> ...]

train.py generates its own train and test clips, but it mixes every target
pronunciation into one directory and keeps no labels, so it cannot answer
"what is recall on 'daymo' alone" or "does the persona saying 'goddamn' wake
it". This writes one directory per phrase set with the same Piper settings
train.py uses for its test clips (noise_scale 1.0, three speaking rates), so a
directory made here is scored by evaluate-clips.py exactly like a train.py one.
"""

import os
import sys

sys.path.insert(0, os.path.abspath("./piper-sample-generator"))

from generate_samples import generate_samples  # noqa: E402


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    out_dir, n_samples, phrases = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
    os.makedirs(out_dir, exist_ok=True)
    generate_samples(
        text=phrases,
        max_samples=n_samples,
        batch_size=50,
        noise_scales=[1.0],
        noise_scale_ws=[1.0],
        length_scales=[0.75, 1.0, 1.25],
        output_dir=out_dir,
        auto_reduce_batch_size=True,
    )


if __name__ == "__main__":
    main()
