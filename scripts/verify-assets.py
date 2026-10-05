"""Verify shipped original sprites, sparse animation data, and optional source ZIP.

No network requests are made. With --archive, verify every pinned source hash and
reconstructed PNG pixel. Requires Pillow; archive reconstruction also uses requests.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import zipfile

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "frontend" / "public" / "assets"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def within_assets(relative: str) -> Path:
    path = (ASSETS / relative).resolve()
    require(path.is_relative_to(ASSETS.resolve()), f"Asset path escapes directory: {relative}")
    require(path.is_file(), f"Missing asset: {relative}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--report", type=Path)
    options = parser.parse_args()
    manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
    payload = json.loads((ASSETS / "animations.json").read_text(encoding="utf-8"))
    sources = json.loads((ASSETS / "sources.json").read_text(encoding="utf-8"))
    require(manifest["sourceCommit"] == sources["commit"], "Source commits do not match")
    require((manifest["canvasWidth"], manifest["canvasHeight"]) == (800, 600), "Original scene must use 800 x 600")
    images = {}
    for key, relative in manifest["images"].items():
        with Image.open(within_assets(relative)) as image:
            image.load()
            size = manifest["imageDimensions"][key]
            require(image.size == (size["width"], size["height"]), f"Wrong dimensions: {key}")
            require(image.mode == "RGBA", f"Converted sprite is not RGBA: {key}")
            images[key] = image.copy()
    for group in ("fonts", "sounds"):
        for relative in manifest[group].values():
            within_assets(relative)
    for alias, key in manifest["aliases"].items():
        require(key in images, f"Unresolved alias: {alias}")
    animations = payload["animations"]
    require(set(animations) == {"tree", "clouds", "treefood", "coin", "pot"}, "Missing original animation")
    references = 0
    for name, animation in animations.items():
        require(animation["fps"] > 0 and animation["frameCount"] > 0, f"Invalid timing: {name}")
        for track in animation["tracks"]:
            require(len(track["frames"]) <= animation["frameCount"], f"Track is too long: {name}/{track['name']}")
            for frame in track["frames"]:
                if frame.get("i"):
                    references += 1
                    require(frame["i"] in images, f"Unresolved animation image: {name}/{frame['i']}")
        for range_name, span in animation["ranges"].items():
            require(0 <= span["start"] <= span["end"] < animation["frameCount"], f"Invalid animation range: {name}/{range_name}")
        raw = within_assets("original/" + animation["source"]).read_bytes()
        require(digest(raw) == animation["sha256"] == sources["sources"][animation["source"]]["sha256"], f"Raw reanim hash differs: {name}")
    require("anim_start" in animations["tree"]["ranges"], "Tree has no initial range")
    for stage in range(1, 52):
        require(f"anim_grow{stage}" in animations["tree"]["ranges"], f"Missing growth stage: {stage}")
    for cloud in range(1, 7):
        require(f"Cloud{cloud}" in animations["clouds"]["ranges"], f"Missing cloud: {cloud}")
    behavior = payload["stages"]["originalBehavior"]
    require(behavior["growthFramesPerSecond"] == 8 and behavior["cloudFramesPerSecond"] == 0.2, "Gameplay frame rates differ")
    verified_sources = 0
    verified_pixels = 0
    if options.archive:
        archive_data = options.archive.read_bytes()
        require(digest(archive_data) == sources["archive"]["sha256"], "Source archive SHA-256 differs")
        archive = zipfile.ZipFile(io.BytesIO(archive_data))
        prefix = archive.namelist()[0].split("/")[0] + "/"
        for path, record in sources["sources"].items():
            data = archive.read(prefix + path)
            require(digest(data) == record["sha256"] and len(data) == record["bytes"], f"Original hash differs: {path}")
            verified_sources += 1
        for key, converted in images.items():
            if key == "EMPTY_POT":
                continue
            folder, stem = ("reanim", key[len("IMAGE_REANIM_"):]) if key.startswith("IMAGE_REANIM_") else ("images", key[len("IMAGE_"):])
            matches = [path for path in sources["sources"] if Path(path).parent.as_posix() == folder and Path(path).stem.upper() == stem and Path(path).suffix.lower() in (".png", ".jpg", ".jpeg")]
            require(bool(matches), f"No pinned image source: {key}")
            source = sorted(matches, key=lambda path: (Path(path).suffix.lower() != ".png", path))[0]
            expected = Image.open(io.BytesIO(archive.read(prefix + source))).convert("RGBA")
            mask_path = str(Path(source).with_name(Path(source).stem + "_.png")).replace("\\", "/")
            if Path(source).suffix.lower() in (".jpg", ".jpeg") and mask_path in sources["sources"]:
                expected.putalpha(Image.open(io.BytesIO(archive.read(prefix + mask_path))).convert("L"))
            require(expected.size == converted.size and ImageChops.difference(expected, converted).getbbox(alpha_only=False) is None, f"Converted pixels differ: {key}")
            verified_pixels += 1
        specification = importlib.util.spec_from_file_location("asset_import", ROOT / "scripts" / "import-assets.py")
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        pot_pose = manifest["potPose"]
        expected_pot = module.render_pose(animations["pot"], pot_pose["frame"], images, (256, 256), tuple(pot_pose["renderOffset"])).crop(tuple(pot_pose["crop"]))
        require(expected_pot.size == images["EMPTY_POT"].size and ImageChops.difference(expected_pot, images["EMPTY_POT"]).getbbox(alpha_only=False) is None, "Original composed empty pot differs")
        verified_pixels += 1
    report = {
        "result": "passed",
        "sourceCommit": sources["commit"],
        "scene": [800, 600],
        "images": len(images),
        "animations": len(animations),
        "growthStages": 51,
        "cloudRanges": 6,
        "animationImageReferences": references,
        "sourceRecords": len(sources["sources"]),
        "sourceHashesChecked": verified_sources,
        "convertedImagesCompared": verified_pixels,
        "fonts": len(manifest["fonts"]),
        "sounds": len(manifest["sounds"]),
    }
    if options.report:
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
