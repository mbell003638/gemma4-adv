# On-device Needle / Gemma

Live `codex-sol` / `Manus` are not this work. Use `codex-sol-on-device-ai` and `Manus-on-device-ai`. Restore with tags `pre-on-device-ai-codex-sol` and `pre-on-device-ai-manus`.

## Who does what

**Agent / laptop (already scripted):**

```
pip install cactus-needle
node ./scripts/on-device-ai/fetch-native.mjs
```

That pulls public `needle2.cact` (~14MB) and `libneedle.a` (~21MB) into the Android module.

## Fine-tune on this laptop (no AI credits)

Does **not** call OpenRouter, Gemini, or `needle generate-data`. It only uses the local JSONL templates.

```
pip install cactus-needle
node ./scripts/on-device-ai/finetune-needle.mjs
```

That writes `needle2-ledgr.cact` and copies it to `modules/ledgr-native-ai/android/src/main/assets/needle2.cact`. Then bake the APK from GitHub as usual.

Training writes `needle-ledgr-train-ckpt.pkl` every 25 steps. If the PC dies, run the same command and it continues from the last checkpoint. Compile still happens once per launch. Delete that `.pkl` (or set `NEEDLE_RESET_CKPT=1`) to start over.

CPU fine-tune can take a while. GPU is faster if JAX sees one, but no paid API is used either way.

**You (phone / EAS):** `npx expo run:android` or an EAS Android build. Metro Fast Reload cannot compile JNI.

The store APK is whoever runs that native build (you locally, or EAS in the cloud). GitHub Actions Android validation compiles; it does not publish to Play.

## Optional Gemma packs

This isolated lab uses the pinned Gemma 4 `.litertlm` catalog and LiteRT-LM
bridge. Advanced Settings downloads approved packs by model ID; native code
checks the pinned size/hash before installation. Do not convert these packs
to `.cact` or replace Needle's trained `needle2.cact` asset.

For the standalone default/Gemma build driver and artifact checks, read
`../../../audit-fix-handoff/FINAL-IMPLEMENTATION-HANDOFF.md` and the dated
A05/A12 build handoff. The owner has deferred all execution for the current
implementation pass. A Metro-dependent debug APK or external JS export is
not a standalone acceptance artifact.
