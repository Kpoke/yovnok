"""
Cut single gunshots out of The Free Firearm Sound Library (CC0, Ben Jaszczak,
Brian Nelson, Kevin Heras, Matthew Nanney) for the window gunners' guns.

    python3 -I scripts/prep/gunshots.py <library dir> <out dir>

Each recording is a take of several shots. Shots are found by their onset (the
envelope jumping from quiet to loud); each is cut from just before the onset
to just before the next shot (or a max length), faded out, and peak-normalised.
The cleanest shots (loud peak, longest clear tail) are kept: a few variants
per gun, so repeated fire does not sound like one sample looping.

Needs ffmpeg and numpy.
"""

import json
import os
import subprocess
import sys

import numpy as np

RATE = 44100

# gun id -> (recordings, max length s, variants, pitch shift)
GUNS = {
    "rifle": (["AR-15/D_24P.wav", "AR-15/D_32P.wav"], 0.9, 3, 1.0),
    "burst": (["AK-47/C_27P.wav", "AK-47/C_29P.wav"], 0.8, 3, 1.0),
    "marksman": (["Savage 10 .300 Blackout/T_17P.wav", "Tikka/W_24P.wav"], 1.4, 2, 1.0),
    "shotgun": (["Mossberg/N_26P.wav", "Nova/O_17P.wav"], 1.3, 2, 1.0),
    "smg": (["PPSh/P_22P.wav", "PPSh/P_34P.wav", "Carl Gustav M45/G_24P.wav", "Carl Gustav M45/G_20P.wav"], 0.45, 3, 1.0),
    # The LMG: a heavy rifle report, a touch lower and longer.
    "lmg": (["AK-47/C_31P.wav", "AK-47/C_36P.wav"], 0.9, 3, 0.88),
    "revolver": (["1917/B_16P.wav", "1917/B_24P.wav", "Ruger Single Six/S_11P.wav", "Ruger Single Six/S_14P.wav"], 1.4, 2, 1.0),
}


def load(path, pitch):
    """Mono float samples at RATE (pitch < 1 lowers it, playing slower)."""
    rate = int(RATE * pitch)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def envelope(x, ms=3):
    n = max(1, int(RATE * ms / 1000))
    return np.convolve(np.abs(x), np.ones(n) / n, mode="same")


def onsets(x):
    env = envelope(x)
    loud = env.max()
    quiet = loud * 0.06
    hits, i = [], 0
    while i < len(env):
        if env[i] > loud * 0.35:
            # Back up to where the rise began.
            j = i
            while j > 0 and env[j] > quiet and i - j < RATE * 0.01:
                j -= 1
            hits.append((j, float(env[i:i + int(RATE * 0.01)].max())))
            i += int(RATE * 0.07)  # skip this shot's body
        else:
            i += 1
    return hits


def main():
    lib, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    report = {}
    for gun, (files, max_len, variants, pitch) in GUNS.items():
        candidates = []
        for f in files:
            x = load(os.path.join(lib, f), pitch)
            hits = onsets(x)
            for k, (start, peak) in enumerate(hits):
                start = max(0, start - int(RATE * 0.004))
                nxt = hits[k + 1][0] if k + 1 < len(hits) else len(x)
                clear = (nxt - start) / RATE
                end = min(nxt - int(RATE * 0.01), start + int(RATE * max_len))
                if end - start < RATE * 0.12:
                    continue
                cut = x[start:end].copy()
                # Fade the last 40% out, so a cut tail never clicks.
                fade = int(len(cut) * 0.4)
                cut[-fade:] *= np.linspace(1, 0, fade) ** 2
                cut /= max(1e-6, np.abs(cut).max()) / 0.89
                # A gunshot is a sharp crack: the first 15 ms far louder than
                # what follows, and only one crack (no second onset in the
                # first 120 ms, which would be two shots or handling noise).
                env = envelope(cut, 2)
                crack = env[: int(RATE * 0.015)].max()
                after = env[int(RATE * 0.03) : int(RATE * 0.12)]
                if len(after) == 0 or crack < 3.0 * after.mean() or after.max() > 0.6 * crack:
                    continue
                score = min(clear, max_len) * peak
                candidates.append((score, f, k, clear, cut))
        candidates.sort(key=lambda c: -c[0])
        report[gun] = []
        for v, (score, f, k, clear, cut) in enumerate(candidates[:variants]):
            name = f"{gun}-{v + 1}.ogg"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "1", "-i", "-", "-c:a", "libvorbis", "-q:a", "4", os.path.join(out, name)],
                input=cut.astype(np.float32).tobytes(),
                check=True,
            )
            report[gun].append({"file": name, "from": f, "shot": k, "length": round(len(cut) / RATE, 3), "clear": round(clear, 3)})
        print(gun, [(r["from"], r["shot"], r["length"]) for r in report[gun]])
    with open(os.path.join(out, "gunshots.json"), "w") as fh:
        json.dump(report, fh, indent=1)


main()
