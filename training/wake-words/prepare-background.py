"""Convert AudioSet parquet shards into 16 kHz mono wav background clips.

Run from the training work directory with the preparation environment:
    .venv-prep/bin/python training/wake-words/prepare-background.py
"""

import io
import os
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import scipy.io.wavfile
import soundfile as sf
import soxr
from tqdm import tqdm

os.makedirs("audioset_16k", exist_ok=True)
for shard in sorted(Path("audioset").glob("*.parquet")):
    for batch in tqdm(pq.ParquetFile(shard).iter_batches(batch_size=16), desc=shard.name):
        for row in batch.to_pylist():
            audio = row["audio"]
            out = os.path.join(
                "audioset_16k", os.path.basename(audio["path"]).rsplit(".", 1)[0] + ".wav"
            )
            if os.path.exists(out):
                continue
            data, rate = sf.read(io.BytesIO(audio["bytes"]), dtype="float32", always_2d=True)
            mono = data.mean(axis=1)
            if rate != 16000:
                mono = soxr.resample(mono, rate, 16000)
            scipy.io.wavfile.write(out, 16000, (np.clip(mono, -1, 1) * 32767).astype(np.int16))

print("audioset_16k:", len(os.listdir("audioset_16k")))
print("mit_rirs:", len(os.listdir("mit_rirs")))
