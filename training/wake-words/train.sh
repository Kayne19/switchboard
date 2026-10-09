#!/usr/bin/env bash
# Train one wake word model end to end: generate clips, augment them, train.
#
# Usage: WORKDIR=~/wakeword-training training/wake-words/train.sh training/wake-words/damo.yml
# Each step is restartable: generation continues until the config's sample
# counts are met, and augmentation rewrites the feature files.
set -euo pipefail
WORKDIR="${WORKDIR:-$HOME/wakeword-training}"
CONFIG="$(realpath "$1")"
cd "$WORKDIR"
ESPEAK="$WORKDIR/espeak-root/usr/lib/x86_64-linux-gnu"
export LD_LIBRARY_PATH="$ESPEAK${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export ESPEAK_DATA_PATH="$ESPEAK"
PYTHON=.venv/bin/python
TRAIN=openWakeWord/openwakeword/train.py
MODEL="$("$PYTHON" -c 'import sys, yaml; config = yaml.safe_load(open(sys.argv[1])); print(config["output_dir"] + "/" + config["model_name"] + ".onnx")' "$CONFIG")"
"$PYTHON" "$TRAIN" --training_config "$CONFIG" --generate_clips
"$PYTHON" "$TRAIN" --training_config "$CONFIG" --augment_clips --overwrite
# train.py declares --convert_to_tflite with default="False", a truthy string,
# so it always attempts the TFLite conversion and exits 1 on the onnx_tf import
# it has no dependency on. The ONNX model is exported before that, and the
# browser loads ONNX, so the model file is the result here, not the exit code.
"$PYTHON" "$TRAIN" --training_config "$CONFIG" --train_model || true
test -s "$MODEL"
echo "trained $WORKDIR/$MODEL"
