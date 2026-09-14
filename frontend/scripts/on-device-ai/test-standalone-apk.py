"""Synthetic acceptance regressions; no Gradle, Android SDK or model download.
Run explicitly with: python -B scripts/on-device-ai/test-standalone-apk.py
"""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("apk_gate", HERE / "verify-standalone-apk.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
NEEDLE = b"preserved-model"


def elf(align=16384, address=0, relro_end=16384, relro=True, flags=6):
    data = bytearray(32768)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", data, 18, 183)
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HH", data, 54, 56, 2 if relro else 1)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, flags, 0, address, 0, len(data), len(data), align)
    if relro:
        struct.pack_into("<IIQQQQQQ", data, 120, 0x6474e552, 4, 0, 0, 0, relro_end, relro_end, 1)
    return bytes(data)


def fixture(path, runtime="gemma", omit=(), replacement=None, misaligned=False, compressed=False, extra=None):
    contents = {
        "assets/index.android.bundle": b"new-embedded-js",
        "assets/needle2.cact": NEEDLE,
        "classes.dex": b"dex\n039\0" + (b"Lcom/google/ai/edge/litertlm/Engine;" if runtime == "gemma" else b"Lapp/Main;"),
        "lib/arm64-v8a/libneedle_jni.so": elf(),
    }
    if runtime == "gemma":
        contents.update({"lib/arm64-v8a/liblitertlm_jni.so": elf(), "assets/model-packs-v2.json": b'{"schema":2,"packs":[{"id":"gemma"}]}'})
    contents.update(replacement or {})
    contents.update(extra or {})
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in contents.items():
            if name in omit:
                continue
            entry = zipfile.ZipInfo(name)
            if name.endswith(".so"):
                entry.compress_type = zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED
                if not misaligned:
                    # ZIP extra fields consist of tag+length+bytes. Pad local data to 16 KB.
                    base = archive.fp.tell() + 30 + len(name.encode("utf-8"))
                    padding = (-base) % 16384
                    if 0 < padding < 4:
                        padding += 16384
                    if padding:
                        entry.extra = struct.pack("<HH", 0xcafe, padding - 4) + bytes(padding - 4)
            archive.writestr(entry, data)


class ElfRegression(unittest.TestCase):
    def test_16k_and_64k_loads_pass(self):
        for alignment in (16384, 65536):
            self.assertEqual(gate.elf_segments(elf(align=alignment))["loads"][0]["align"], alignment)

    def test_original_4k_needle_failure(self):
        with self.assertRaisesRegex(ValueError, "LOAD alignment"):
            gate.elf_segments(elf(align=4096))

    def test_incongruent_offset_fails(self):
        with self.assertRaisesRegex(ValueError, "incongruent"):
            gate.elf_segments(elf(address=4096))

    def test_relro_end_not_16k_fails(self):
        with self.assertRaisesRegex(ValueError, "RELRO end"):
            gate.elf_segments(elf(relro_end=4096))

    def test_relro_does_not_require_large_p_align(self):
        self.assertEqual(gate.elf_segments(elf())["relro"][0]["align"], 1)

    def test_relro_requires_writable_load(self):
        with self.assertRaisesRegex(ValueError, "RELRO outside"):
            gate.elf_segments(elf(flags=5))

    def test_missing_relro_fails(self):
        with self.assertRaisesRegex(ValueError, "Missing GNU_RELRO"):
            gate.elf_segments(elf(relro=False))

    def test_truncated_headers_and_non_arm64_fail(self):
        with self.assertRaises(ValueError):
            gate.elf_segments(elf()[:90])
        data = bytearray(elf())
        struct.pack_into("<H", data, 18, 62)
        with self.assertRaisesRegex(ValueError, "AArch64"):
            gate.elf_segments(data)


class ApkRegression(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.apk = Path(self.directory.name) / "synthetic.apk"

    def reject(self, message, **kwargs):
        fixture(self.apk, **kwargs)
        with self.assertRaisesRegex(ValueError, message):
            gate.inspect_apk(self.apk, kwargs.get("runtime", "gemma"), NEEDLE)

    def test_both_valid_variants_and_asset_hash(self):
        for runtime in ("default", "gemma"):
            fixture(self.apk, runtime=runtime)
            result = gate.inspect_apk(self.apk, runtime, NEEDLE)
            self.assertEqual(result["needle_sha256"], gate.sha(NEEDLE))
            self.assertEqual(result["litert_classes"], runtime == "gemma")
            self.assertIn("assets/index.android.bundle", result["bundles"])

    def test_missing_or_empty_bundle_fails(self):
        self.reject("no bundled JavaScript", omit=("assets/index.android.bundle",))
        self.reject("no bundled JavaScript", replacement={"assets/index.android.bundle": b""})

    def test_required_gemma_assets_fail_independently(self):
        for name in ("lib/arm64-v8a/libneedle_jni.so", "lib/arm64-v8a/liblitertlm_jni.so",
                     "assets/needle2.cact", "assets/model-packs-v2.json"):
            self.reject("Missing", omit=(name,))

    def test_changed_needle_fails(self):
        self.reject("Needle asset differs", replacement={"assets/needle2.cact": b"replacement"})

    def test_default_rejects_litert_dex_and_jni_independently(self):
        self.reject("class presence", runtime="default",
                    replacement={"classes.dex": b"Lcom/google/ai/edge/litertlm/Engine;"})
        self.reject("Default APK contains", runtime="default",
                    extra={"lib/arm64-v8a/liblitertlm_jni.so": elf()})

    def test_gemma_missing_classes_fails(self):
        self.reject("class presence", replacement={"classes.dex": b"Lapp/Main;"})

    def test_every_library_checked_including_vendor(self):
        self.reject("libvendor.so: LOAD alignment",
                    extra={"lib/arm64-v8a/libvendor.so": elf(align=4096)})

    def test_zip_alignment_is_independent_of_elf(self):
        self.reject("ZIP offset", misaligned=True)

    def test_compressed_library_fails(self):
        self.reject("must be uncompressed", compressed=True)

    def test_wrong_abi_fails(self):
        self.reject("arm64-v8a only", extra={"lib/x86_64/libvendor.so": elf()})

    def test_duplicate_zip_entry_fails(self):
        fixture(self.apk)
        with zipfile.ZipFile(self.apk, "a") as archive:
            with self.assertWarns(UserWarning):
                archive.writestr("assets/needle2.cact", NEEDLE)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            gate.inspect_apk(self.apk, "gemma", NEEDLE)

    def test_metadata_rejects_other_lab_and_sdk_changes(self):
        text = "package: name='com.ahem.ledgrai'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n"
        self.assertEqual(gate.metadata(text, "com.ahem.ledgrai", 24, 36)["min_sdk"], 24)
        for package, minimum, target in (("com.ahem.ledgrai.codexsol", 24, 36),
                                         ("com.ahem.ledgrai", 23, 36), ("com.ahem.ledgrai", 24, 35)):
            with self.assertRaises(ValueError):
                gate.metadata(text, package, minimum, target)

    def test_external_zipalign_failure_cannot_report_success(self):
        import subprocess
        fixture(self.apk)
        reference = Path(self.directory.name) / 'needle.cact'
        reference.write_bytes(NEEDLE)
        argv = ['verify', '--apk', str(self.apk), '--runtime', 'gemma',
                '--package', 'com.ahem.ledgrai', '--min-sdk', '24', '--target-sdk', '36',
                '--needle-reference', str(reference), '--zipalign', 'zipalign', '--aapt2', 'aapt2']
        with mock.patch('sys.argv', argv), mock.patch.object(gate.subprocess, 'run',
                side_effect=subprocess.CalledProcessError(1, 'zipalign')), mock.patch('builtins.print') as printed:
            with self.assertRaises(subprocess.CalledProcessError):
                gate.main()
            printed.assert_not_called()


class WorkflowSourceContract(unittest.TestCase):
    def test_manual_opt_in_and_default_jobs_are_separate(self):
        lab = HERE.parents[2]
        for name in ("android-native-validation.yml", "build-apk.yml"):
            source = (lab / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertIn("github.event_name == 'workflow_dispatch' && inputs.gemma_runtime == true", source)
            self.assertIn("github.ref_name == 'codex/manus-gemma4-p0-p3'", source)
            self.assertIn("if: ${{ !inputs.gemma_runtime }}", source)
            self.assertIn("uses: ./.github/workflows/gemma-standalone.yml", source)
            self.assertIn("default: false", source)

    def test_both_variants_have_standalone_and_inspection_gates(self):
        lab = HERE.parents[2]
        source = (lab / ".github/workflows/gemma-standalone.yml").read_text(encoding="utf-8")
        self.assertIn("runtime: ['default', 'gemma']", source)
        self.assertIn("-PledgrGemmaEnabled=$GEMMA_ENABLED", source)
        self.assertIn(":app:assembleRelease", source)
        self.assertIn("verify-standalone-apk.py", source)
        self.assertIn("audit-testsigning.init.gradle", source)
        self.assertNotIn("secrets.", source)
        self.assertNotIn("secrets: inherit", source)
        self.assertNotIn("bundleRelease", source)

    def test_needle_flags_and_conditional_toolchain_preserved(self):
        frontend = HERE.parents[1]
        native = frontend / "modules/ledgr-native-ai/android"
        gradle = (native / "build.gradle").read_text(encoding="utf-8")
        cmake = (native / "src/main/cpp/CMakeLists.txt").read_text(encoding="utf-8")
        plugin = (frontend / "plugins/withGemmaAndroidToolchain.js").read_text(encoding="utf-8")
        self.assertIn("-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON", gradle)
        self.assertIn("if (gemmaEnabled)", gradle)
        self.assertIn("ledgrRequireNeedle", gradle)
        for flag in ("max-page-size=16384", "common-page-size=16384"):
            self.assertIn(flag, cmake)
        self.assertIn("2.4.0", plugin)
        self.assertIn("2.3.10", plugin)
        self.assertIn("== 'true'", plugin)
        self.assertNotIn("skip-metadata-version-check", plugin)


if __name__ == "__main__":
    unittest.main()
