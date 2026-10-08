
"""Load the DeepPhonemizer en_us_cmudict_forward checkpoint and re-save it for `dp`.

The checkpoint openWakeWord downloads lives in an S3 bucket that now answers
403. The same official checkpoint is mirrored on HuggingFace, re-serialized for
the `ilt-deep-phonemizer` fork, so its pickle names `deep_phonemizer.*` where
`deep-phonemizer` 0.0.19 names `dp.*`. Alias the modules, load it, and write a
`dp`-named checkpoint openWakeWord can load unchanged.
"""
import functools
import importlib
import sys

import torch

for name in ["", ".preprocessing", ".preprocessing.text", ".model", ".model.model", ".training", ".training.trainer"]:
    sys.modules["deep_phonemizer" + name] = importlib.import_module("dp" + name)

torch.load = functools.partial(torch.load, weights_only=False)

from dp.phonemizer import Phonemizer  # noqa: E402

source, destination = sys.argv[1], sys.argv[2]
checkpoint = torch.load(source, map_location="cpu")
torch.save(checkpoint, destination)
phonemizer = Phonemizer.from_checkpoint(destination)
for word in ["daymo", "dammo", "damocles"]:
    print(word, phonemizer(word, lang="en_us"))
