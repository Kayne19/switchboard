#!/usr/bin/env bash
# Download the augmentation and negative data the training configs name.
#
# Downloads about 21 GB: the 16 GB precomputed ACAV100M negative features, the
# 185 MB validation negatives, 270 MIT room impulse responses, and five
# AudioSet balanced-train shards (3.4 GB of parquet, deleted after they are
# converted to about 800 MB of 16 kHz wavs).
#
# Usage: WORKDIR=~/wakeword-training training/wake-words/download-data.sh
set -euo pipefail
WORKDIR="${WORKDIR:-$HOME/wakeword-training}"
cd "$WORKDIR"

FEATURES=https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main
curl -L --retry 5 -C - -o validation_set_features.npy "$FEATURES/validation_set_features.npy"
curl -L --retry 5 -C - -o openwakeword_features_ACAV100M_2000_hrs_16bit.npy \
	"$FEATURES/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"

# MIT environmental impulse responses, already at 16 kHz.
RIRS=https://huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses
mkdir -p mit_rirs
.venv-prep/bin/python - <<'PY' > rir_files.txt
import json
import urllib.request

tree = json.load(urllib.request.urlopen(
	"https://huggingface.co/api/datasets/davidscripka/MIT_environmental_impulse_responses/tree/main/16khz"
))
print("\n".join(entry["path"] for entry in tree if entry["type"] == "file"))
PY
while read -r remote; do
	local="mit_rirs/$(basename "$remote")"
	[ -f "$local" ] || curl -L --retry 3 -o "$local" "$RIRS/resolve/main/$remote"
done < rir_files.txt

# Background noise and music: AudioSet balanced-train shards.
mkdir -p audioset
AUDIOSET=https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train
for shard in 00 09 17 26 33; do
	[ -f "audioset/$shard.parquet" ] || curl -L --retry 5 -o "audioset/$shard.parquet" "$AUDIOSET/$shard.parquet"
done
.venv-prep/bin/python "$(dirname "$(realpath "$0")")/prepare-background.py"
rm -rf audioset

du -sh mit_rirs audioset_16k
