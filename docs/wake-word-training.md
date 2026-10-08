# Training the wake word models

The page listens for two custom openWakeWord models, `damocles` and `damo`
(trained on both "daymo" and "dammo"). Each is a small head over openWakeWord's
frozen feature extractor, trained with openWakeWord's automatic training
pipeline: Piper synthetic positives, room impulse response and background noise
augmentation, and precomputed negative features.

Nothing here runs in CI, and no training data or environment belongs in this
repository. The scripts build everything in a work directory outside it
(`$WORKDIR`, default `~/wakeword-training`). Only the configs, the scripts, and
the exported `.onnx` models are committed.

## Retraining

On a host with an NVIDIA GPU, about 25 GB of free disk, and `uv`:

```sh
training/wake-words/setup.sh          # environments and upstream code
training/wake-words/download-data.sh  # about 21 GB, the 16 GB feature file included
training/wake-words/train.sh training/wake-words/damocles.yml
training/wake-words/train.sh training/wake-words/damo.yml
```

Each `train.sh` runs openWakeWord's three steps — generate clips, augment them,
train — and writes `$WORKDIR/models/<name>.onnx`. Copy that file to
`training/wake-words/models/<name>_v0.1.onnx`; `npm run build` stages it into
`static/openwakeword/models/`, which is where the browser loads it from.

Then measure it, from the work directory, with this repository's scripts:

```sh
cd $WORKDIR
R=<repo>/training/wake-words
.venv/bin/python $R/evaluate.py models/damo.onnx models/damo --out window-damo.json
.venv/bin/python $R/evaluate-clips.py models/damo.onnx models/damo/positive_test \
  --limit 500 --out clean-damo.json
.venv/bin/python $R/evaluate-clips.py models/damo.onnx models/damo/positive_test \
  --limit 300 --augment --out augmented-damo.json
```

`train.py` mixes every pronunciation into one unlabelled test directory and
generates nothing for the words that must *not* wake the page, so
`generate-clips.py` makes those directories. `evaluate-clips.py` scores one the
same way either way: on the target word the number is recall, on anything else
it is the false-accept rate per utterance.

```sh
.venv/bin/python $R/generate-clips.py testsets/daymo 500 daymo
.venv/bin/python $R/generate-clips.py testsets/dammo 500 dammo
.venv/bin/python $R/generate-clips.py testsets/demo 300 demo
.venv/bin/python $R/generate-clips.py testsets/swearing 500 \
  damn goddamn "goddamn it" "oh damn" "damn right" dammit "god damn it" "damn that"
for set in daymo dammo demo swearing; do
  .venv/bin/python $R/evaluate-clips.py models/damo.onnx testsets/$set --out $set-damo.json
done
```

`evaluate.py` is the training run's own view: one saved feature window per
held-out positive, the 11.3-hour openWakeWord validation negatives, and the
adversarial negatives, at each threshold. Its false accepts per hour are the
number to trust: it scores every stride-1 window of the negatives, which is
the rate the browser scores at. Its recall is not, and this is why:

- The positive it scores is one 16-embedding window saved by the training run,
  and the training run augments its held-out positives exactly like its
  training positives — background noise mixed in at an SNR drawn from -10 to
  +15 dB (`openwakeword/data.py`). It is recall on deliberately wrecked audio.
- `evaluate-clips.py` is the deployment view instead: it slides the window
  across the whole utterance and takes the highest score, which is what the
  browser does. It pads a second of silence onto each end, as openWakeWord's
  own `predict_clip` does, because the detector needs 16 embeddings (about
  1.44 s) to fill one window and a one-second clip cannot fill it with the
  phrase and the trailing silence the model was trained on. A microphone
  stream always supplies that context; without the padding the same model
  measures about twenty points worse, which is how the second round's models
  were read as failures.
- `--augment` first puts the utterance through openWakeWord's own
  augmentation, that -10 dB background noise included, which is the hardest
  condition in the training data and much harder than a quiet room with a near
  microphone. Clean and augmented bracket the real room.

The thresholds in `apps/frontend/src/wake_models.ts` are the highest ones that
keep `evaluate.py`'s false accepts per hour at or under 0.5 while utterance
recall stays usable, and for "damo" also keep the false-accept rate on "demo",
its closest neighbour in English, low.

## The two configs

`damocles.yml` and `damo.yml` are openWakeWord training configs; every field is
documented in [the upstream example](https://github.com/dscripka/openWakeWord/blob/main/examples/custom_model.yml).
What is specific to this repository:

- `damo.yml` trains one model on two spellings, `daymo` and `dammo`, because
  the word is said both ways: `daymo` phonemizes to `D EY M OW` and `dammo` to
  `D AE M OW`, which is exactly the pair wanted. `damo` alone gives
  `D AA M OW`, "dah-mo", which is neither.
- `damo.yml` carries a long `custom_negative_phrases` list ("damn", "goddamn",
  "demo", "Damon", "dynamo", "domo", "day", "dam" and more). The word is one
  phoneme from everyday speech, and the voice persona says "goddamn" often, so
  a self-trigger from speaker audio reaching the microphone is a real risk.
- No negative phrase may be a homophone of a target phrase, or contain one.
  This is the rule the first two rounds broke, in both configs, and it cost
  more recall than every other setting put together:
  - `damo.yml` listed "damn oh" and "dam oh". The pipeline's own phonemizer
    (DeepPhonemizer over the CMU dictionary, which `train.py` uses for words
    the dictionary lacks) reads both as `D AE M | OW` — the exact phonemes of
    the target "dammo", `D AE M OW`. Piper synthesizes them the same way, so
    the run labelled the same sounds positive and adversarial-negative, and
    the model learned to score its own target down. Recall on "dammo" was
    half the recall on "daymo" because the contradiction landed on that
    pronunciation alone.
  - `damocles.yml` listed "damocles sword" and "sword of damocles", which
    *contain* `D AE M AH K L IY Z`. Dropping them took recall on noisy
    utterances from 0.38 to 0.67.
  Keep near misses, which is the point of the list: "demo" (`D EH M OW`) and
  "domo" (`D OW M OW`) are one vowel from "daymo", "day no" (`D EY N OW`) one
  consonant, "damn" and "dam" (`D AE M`) one phoneme from "dammo". Check a new
  phrase with the phonemizer before adding it, and drop it if it comes out
  identical to a target.
- Both configs target 0.5 false accepts per hour, the budget the page is held
  to. `target_false_positives_per_hour` is not a threshold: `auto_train`
  doubles `max_negative_weight` between its three sequences whenever the
  running false-accept rate is above it, so a target far below the budget
  (0.1, as the second round used) buys false-accept headroom nobody asked for
  with recall. Strictness where it is wanted — "damo" is the risky word —
  belongs in that model's detection threshold, which is where
  `apps/frontend/src/wake_models.ts` puts it.
- The backgrounds are five AudioSet balanced-train shards (about seven hours of
  noise and music) rather than the notebook's AudioSet tar plus Free Music
  Archive: the FMA dataset on HuggingFace is a loading script, which current
  `datasets` releases no longer run.

## Measured performance

These are the v3 models, the ones in `training/wake-words/models/`. Every
column is per utterance except false accepts per hour.

- **clean** and **noisy**: recall over the 2,000 held-out Piper utterances the
  run set aside, streamed whole, clean and then through openWakeWord's own
  augmentation (background noise from -10 to +15 dB SNR). A quiet room with a
  near microphone sits near the clean column; the noisy column is the floor.
- **FP/h**: false accepts per hour on the 11.3-hour openWakeWord validation
  negatives (speech, noise and music), scored on every stride-1 window, the
  same denominator openWakeWord's trainer reports.
- **"demo"** and **swearing**: the false-accept rate on 300 "demo" utterances
  and on 500 of the persona's swearing ("damn", "goddamn", "goddamn it", "oh
  damn", "damn right", "dammit", "god damn it", "damn that"), which is the
  speaker-bleed risk the issue names.

### damocles, threshold 0.5

| threshold | clean | noisy | FP/h | "demo" | swearing |
| --- | --- | --- | --- | --- | --- |
| 0.1 | 0.976 | 0.750 | 0.18 | 0.000 | 0.002 |
| 0.3 | 0.962 | 0.717 | 0.09 | 0.000 | 0.000 |
| **0.5** | **0.956** | **0.670** | **0.00** | **0.000** | **0.000** |
| 0.7 | 0.934 | 0.617 | 0.00 | 0.000 | 0.000 |
| 0.9 | 0.900 | 0.510 | 0.00 | 0.000 | 0.000 |

0.5 is the first threshold with no false accept at all in 11.3 hours, and it
costs two points of clean recall against 0.1. "Damocles" is four syllables and
nothing in English is close to it: it never fired on "daymo", "dammo", "demo"
or the swearing at any threshold.

### damo, threshold 0.6

"daymo" and "dammo" are scored separately here, on 500 utterances each, because
the training run mixes them into one unlabelled directory.

| threshold | "daymo" | "dammo" | noisy (both) | FP/h | "demo" | swearing |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1 | 0.870 | 0.820 | 0.543 | 0.62 | 0.583 | 0.002 |
| 0.3 | 0.756 | 0.672 | 0.413 | 0.09 | 0.327 | 0.000 |
| 0.5 | 0.674 | 0.530 | 0.320 | 0.00 | 0.203 | 0.000 |
| **0.6** | **0.630** | **0.438** | **0.267** | **0.00** | **0.133** | **0.000** |
| 0.7 | 0.554 | 0.320 | 0.187 | 0.00 | 0.070 | 0.000 |
| 0.8 | 0.432 | 0.136 | 0.107 | 0.00 | 0.033 | 0.000 |

"Damo" is not false-positive limited on the validation negatives — nothing in
11.3 hours of speech, noise and music fires it above 0.4 — so its threshold is
set by "demo", the one English word a vowel away from both pronunciations.
0.6 keeps about two thirds of "daymo" and four in nine "dammo" while one spoken
"demo" in eight wakes the page; 0.7 halves that at a tenth of the recall. 0.6
is the choice, and it is still stricter than "damocles", which is the point.
"daymo" scores above "dammo" at every threshold: it is the longer vowel and the
one with no neighbour in the negative set.

Nothing here is measured on Kayne's voice or in his room. The models have never
heard a human say either word; everything above is Piper. Issue #185 leaves the
20 to 50 real recordings for later, and they are what would move these
thresholds.

## Licensing

The heads in `training/wake-words/models/` are ours. They sit on openWakeWord's
`melspectrogram.onnx` and `embedding_model.onnx`, which openWakeWord documents
under CC BY-NC-SA 4.0, and they are trained on synthetic Piper speech,
precomputed openWakeWord features from ACAV100M, MIT room impulse responses,
and AudioSet clips. `docs/hands-free.md` records what that means for the
deployed page.
