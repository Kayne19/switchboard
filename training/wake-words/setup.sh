#!/usr/bin/env bash
# Build the openWakeWord training environment for the switchboard wake words.
#
# Everything lands in $WORKDIR (default ~/wakeword-training), outside this
# repository and outside the system Python. Needs curl, git, uv, dpkg-deb and
# apt-get (download only; no root), and about 25 GB of disk.
#
# Usage: WORKDIR=~/wakeword-training training/wake-words/setup.sh
set -euo pipefail
WORKDIR="${WORKDIR:-$HOME/wakeword-training}"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# espeak-ng's shared library and data, which espeak-phonemizer dlopens.
# Extracted from the Ubuntu packages so the host needs no root.
if [ ! -d espeak-root ]; then
	mkdir -p debs espeak-root
	(cd debs && apt-get download libespeak-ng1 espeak-ng-data libpcaudio0 libsonic0)
	for deb in debs/*.deb; do dpkg-deb -x "$deb" espeak-root; done
fi

# Upstream training code: openWakeWord's automatic trainer and the Piper
# sample generator fork its train.py calls.
[ -d piper-sample-generator ] || git clone --depth 1 https://github.com/dscripka/piper-sample-generator
[ -f piper-sample-generator/models/en-us-libritts-high.pt ] ||
	curl -L --retry 5 -o piper-sample-generator/models/en-us-libritts-high.pt \
		'https://github.com/rhasspy/piper-sample-generator/releases/download/v1.0.0/en-us-libritts-high.pt'
[ -d openWakeWord ] || git clone --depth 1 https://github.com/dscripka/openWakeWord

# torch 2.6 defaults torch.load to weights_only=True; the Piper generator
# ships a pickled SynthesizerTrn module, so it has to load in full.
sed -i 's/model = torch.load(model_path)$/model = torch.load(model_path, weights_only=False)/' \
	piper-sample-generator/generate_samples.py

# The training environment. openwakeword installs with --no-deps: its runtime
# extras (ai-edge-litert, speexdsp-ns) are not needed to train and do not
# build here. The pins are the ones this combination needs: scipy < 1.15 for
# acoustics, setuptools < 81 for webrtcvad's pkg_resources, numpy < 2 for
# speechbrain and audiomentations.
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python --torch-backend=cu124 torch torchaudio
uv pip install --python .venv/bin/python "numpy<2" "scipy<1.15" scikit-learn tqdm pyyaml requests \
	"setuptools<81" torchinfo torchmetrics speechbrain audiomentations==0.33.0 \
	torch-audiomentations==0.11.0 acoustics==0.2.6 mutagen==1.47.0 pronouncing webrtcvad \
	espeak-phonemizer onnx onnxruntime
uv pip install --python .venv/bin/python --no-deps -e ./openWakeWord

# openWakeWord phonemizes the target phrase to generate adversarial negatives,
# and falls back to DeepPhonemizer for words the CMU dictionary does not have
# ("daymo", "dammo"). The checkpoint it downloads lives in an S3 bucket that
# now answers 403; the same official checkpoint is mirrored on HuggingFace,
# re-serialized for a fork, so convert-phonemizer.py renames its modules back.
uv pip install --python .venv/bin/python deep-phonemizer==0.0.19
# deep-phonemizer 0.0.19 predates torch 2.6's weights_only default.
sed -i 's/checkpoint = torch.load(checkpoint_path, map_location=device)$/checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)/' \
	.venv/lib/python3.11/site-packages/dp/model/model.py
if [ ! -f openWakeWord/openwakeword/resources/en_us_cmudict_forward.pt ]; then
	curl -L --retry 5 -o cmudict_forward_ilt.pt \
		https://huggingface.co/NRC-CNRC/en_us_cmudict_ipa_forward_g2p/resolve/main/en_us_cmudict_forward.pt
	.venv/bin/python "$(dirname "$(realpath "$0")")/convert-phonemizer.py" \
		cmudict_forward_ilt.pt openWakeWord/openwakeword/resources/en_us_cmudict_forward.pt
	rm -f cmudict_forward_ilt.pt
fi

# The frozen feature extractor the trained head sits on.
mkdir -p openWakeWord/openwakeword/resources/models
for model in embedding_model.onnx melspectrogram.onnx; do
	[ -f "openWakeWord/openwakeword/resources/models/$model" ] ||
		curl -L --retry 5 -o "openWakeWord/openwakeword/resources/models/$model" \
			"https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$model"
done

# A second environment for data preparation only: it reads AudioSet parquet
# shards and needs a newer pyarrow than the training environment pins.
uv venv --python 3.11 .venv-prep
uv pip install --python .venv-prep/bin/python numpy scipy pyarrow soundfile soxr tqdm

echo "setup complete in $WORKDIR"
