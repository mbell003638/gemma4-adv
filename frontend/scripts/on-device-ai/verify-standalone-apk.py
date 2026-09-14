#!/usr/bin/env python3
"""Read-only APK acceptance gate. Standard library only; never extracts entries.
Run only when validation is authorized. JSON goes to stdout; failures exit nonzero.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile

PAGE = 16384


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def elf_segments(data):
    require(len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01", "Expected little-endian ELF64")
    require(struct.unpack_from("<H", data, 18)[0] == 183, "Expected AArch64 ELF")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    entsize, count = struct.unpack_from("<HH", data, 54)
    require(entsize >= 56 and 0 < count < 65535, "Invalid program header table")
    require(phoff + entsize * count <= len(data), "Truncated program headers")
    loads, relros = [], []
    for index in range(count):
        kind, flags, offset, address, _, filesz, memsz, align = struct.unpack_from(
            "<IIQQQQQQ", data, phoff + index * entsize)
        if kind not in (1, 0x6474e552):
            continue
        require(filesz <= memsz and offset + filesz <= len(data), "Invalid segment extent")
        segment = dict(offset=offset, address=address, filesz=filesz, memsz=memsz, align=align, flags=flags)
        if kind == 1:
            require(align >= PAGE and align & (align - 1) == 0, "LOAD alignment below 16 KB or not power of two")
            require(offset % align == address % align, "LOAD offset/address incongruent")
            loads.append(segment)
        else:
            relros.append(segment)
    require(loads, "No LOAD segments")
    require(relros, "Missing GNU_RELRO")
    for relro in relros:
        start, end = relro["address"], relro["address"] + relro["memsz"]
        require(end > start and end % PAGE == 0, "RELRO end is not 16 KB aligned")
        # RELRO may start within a page. Require its protected pages to belong to
        # one writable LOAD, and do not demand p_align=16384 for GNU_RELRO.
        require(any(load["flags"] & 2 and load["address"] <= start and end <= load["address"] + load["memsz"]
                    for load in loads), "RELRO outside LOAD")
    return dict(loads=loads, relro=relros)


def zip_data_offset(stream, entry):
    stream.seek(entry.header_offset)
    header = stream.read(30)
    require(len(header) == 30 and header[:4] == b"PK\x03\x04", "Invalid local ZIP header")
    name_size, extra_size = struct.unpack_from("<HH", header, 26)
    return entry.header_offset + 30 + name_size + extra_size


def metadata(badging, package, min_sdk, target_sdk):
    match = re.search(r"^package: name='([^']+)'", badging, re.M)
    require(match and match[1] == package, "Wrong application ID")
    for field, expected in (("sdkVersion", min_sdk), ("targetSdkVersion", target_sdk)):
        match = re.search(r"^" + field + r":'([0-9]+)'", badging, re.M)
        require(match and int(match[1]) == expected, "Wrong or missing " + field)
    return dict(package=package, min_sdk=min_sdk, target_sdk=target_sdk)


def inspect_apk(apk, runtime, needle_bytes):
    require(runtime in ('default', 'gemma'), 'Unknown runtime')
    with zipfile.ZipFile(apk) as archive, open(apk, "rb") as stream:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(names)), "Duplicate ZIP entries")
        bundles = [name for name in names if re.fullmatch(r"assets/.*\.(bundle|hbc)", name)
                   and archive.getinfo(name).file_size > 0]
        require(bundles, "APK has no bundled JavaScript")
        required = ["lib/arm64-v8a/libneedle_jni.so", "assets/needle2.cact"]
        if runtime == "gemma":
            required += ["lib/arm64-v8a/liblitertlm_jni.so", "assets/model-packs-v2.json"]
        for name in required:
            require(name in names and archive.getinfo(name).file_size > 0, "Missing " + name)
        asset = archive.read("assets/needle2.cact")
        require(asset == needle_bytes and len(asset) > 0, "Needle asset differs from reference")
        dex_names = [name for name in names if re.fullmatch(r"classes[0-9]*\.dex", name)]
        require(dex_names, "Missing DEX")
        # Builds under this gate disable R8; descriptors must remain observable.
        litert_classes = any(b"Lcom/google/ai/edge/litertlm/" in archive.read(name) for name in dex_names)
        require(litert_classes == (runtime == "gemma"), "LiteRT class presence does not match runtime")
        if runtime == "default":
            require(not any("litertlm" in name.lower() and name.endswith(".so") for name in names),
                    "Default APK contains LiteRT-LM JNI")
        libs = [entry for entry in entries if entry.filename.startswith("lib/") and entry.filename.endswith(".so")]
        require(libs and all(entry.filename.startswith("lib/arm64-v8a/") for entry in libs),
                "Expected arm64-v8a only")
        results = {}
        for entry in libs:
            require(entry.compress_type == zipfile.ZIP_STORED, "Native library must be uncompressed: " + entry.filename)
            offset = zip_data_offset(stream, entry)
            require(offset % PAGE == 0, "Native ZIP offset is not 16 KB aligned: " + entry.filename)
            try:
                results[entry.filename] = dict(elf_segments(archive.read(entry)), zip_offset=offset)
            except ValueError as error:
                raise ValueError(entry.filename + ": " + str(error)) from error
        catalog = None
        if runtime == "gemma":
            catalog = json.loads(archive.read("assets/model-packs-v2.json"))
            require(isinstance(catalog, (dict, list)) and bool(catalog), "Empty native catalog")
        return dict(runtime=runtime, bundles={name: sha(archive.read(name)) for name in bundles},
                    needle_sha256=sha(asset), libraries=results,
                    native_assets=[name for name in names if name.startswith("assets/")],
                    litert_classes=litert_classes, catalog=catalog)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--runtime", choices=("default", "gemma"), required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--min-sdk", type=int, required=True)
    parser.add_argument("--target-sdk", type=int, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--baseline-apk", type=Path)
    source.add_argument("--needle-reference", type=Path)
    parser.add_argument("--zipalign", type=Path, required=True)
    parser.add_argument("--aapt2", type=Path, required=True)
    args = parser.parse_args()
    if args.baseline_apk:
        require(args.baseline_apk.resolve() != args.apk.resolve(), 'Baseline must be a separate historical APK')
        with zipfile.ZipFile(args.baseline_apk) as baseline:
            needle = baseline.read("assets/needle2.cact")
    else:
        needle = args.needle_reference.read_bytes()
    report = inspect_apk(args.apk, args.runtime, needle)
    zipped = subprocess.run([str(args.zipalign.resolve()), "-c", "-P", "16", "4", str(args.apk.resolve())],
                            check=True, capture_output=True, text=True)
    badging = subprocess.run([str(args.aapt2.resolve()), "dump", "badging", str(args.apk.resolve())],
                             check=True, capture_output=True, text=True)
    report.update(metadata(badging.stdout, args.package, args.min_sdk, args.target_sdk))
    report.update(apk=str(args.apk.resolve()), size=args.apk.stat().st_size,
                  sha256=sha(args.apk.read_bytes()), zipalign=zipped.stdout,
                  badging=badging.stdout, needle_reference=str(args.baseline_apk or args.needle_reference))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
