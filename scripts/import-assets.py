"""Import selected original PvZ assets and convert PopCap reanim XML for Canvas.

Run from any directory: python scripts/import-assets.py
Requires requests and Pillow. No credentials or game executable is required.
Only the archive cache and frontend/public/assets are written.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "8ba94e95cfe7d0de5682f8258d3b932dbdac885c"
REPOSITORY = "FregD156/PvZ_Assets"
ARCHIVE_URL = f"https://codeload.github.com/{REPOSITORY}/zip/{COMMIT}"
DEFAULT_CACHE = ROOT / ".local" / "asset-source"
ANIMATIONS = {
    "tree": "reanim/treeofWisdom.reanim",
    "clouds": "reanim/TreeOfWisdomClouds.reanim",
    "treefood": "reanim/TreeFood.reanim",
    "coin": "reanim/Coin_gold.reanim",
    "pot": "reanim/Pot.reanim",
}
UI = [
    "images/TreeFood.png", "images/coinbank.png", "images/plantspeechbubble.png",
    "images/zenshopbutton.png", "images/zenshopbutton_highlight.png",
    "images/Zen_NextGarden.png", "images/Store_TreeOfWisdomIcon.png",
    "images/button_left.png", "images/button_middle.png", "images/button_right.png",
    "images/button_down_left.png", "images/button_down_middle.png", "images/button_down_right.png",
    "images/SeedChooser_Button.png", "images/SeedChooser_Button_Glow.png",
    "images/SeedChooser_Button_Disabled.png",
    "images/Store_MainMenuButton.png", "images/Store_MainMenuButtonDown.png",
    "images/Store_MainMenuButtonHighlight.png",
    "images/Store_SpeechBubble.png", "images/Store_SpeechBubble2.png",
]
FONT_PREFIXES = ("BrianneTod16", "_BrianneTod16", "DwarvenTodcraft18", "HouseofTerror16", "_HouseofTerror16", "HouseofTerror20", "_HouseofTerror20")
SOUNDS = ("fertilizer", "plantgrow", "points", "buttonclick", "zen", "coin")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def dump(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def parse_animation(data: bytes, source: str) -> dict:
    content = data.decode("utf-8-sig")
    content = re.sub(r"<\?xml[^>]+\?>", "", content)
    root = ET.fromstring("<root>" + content + "</root>")
    result = {"source": source, "sha256": sha256(data), "fps": float(root.findtext("fps") or "12"),
              "frameCount": 0, "tracks": [], "ranges": {}}
    for track in root.findall("track"):
        name = track.findtext("name") or ""
        frames = []
        visibility = 0
        active = []
        for index, transform in enumerate(track.findall("t")):
            frame = {}
            for field in transform:
                if field.tag not in ("x", "y", "kx", "ky", "sx", "sy", "a", "f", "i") or not field.text:
                    continue
                frame[field.tag] = field.text if field.tag == "i" else float(field.text)
            frames.append(frame)
            visibility = frame.get("f", visibility)
            if visibility >= 0:
                active.append(index)
        result["tracks"].append({"name": name, "frames": frames})
        result["frameCount"] = max(result["frameCount"], len(frames))
        if (name.startswith("anim_") or name.startswith("Cloud")) and active:
            result["ranges"][name] = {"start": min(active), "end": max(active)}
    return result


def pose(animation: dict, index: int) -> list[tuple[str, dict]]:
    state = {"x": 0, "y": 0, "kx": 0, "ky": 0, "sx": 1, "sy": 1, "a": 1, "f": 0, "i": ""}
    result = []
    for track in animation["tracks"]:
        current = state.copy()
        for frame in track["frames"][:index + 1]:
            current.update(frame)
        if current["i"] and current["f"] >= 0 and current["a"] > 0:
            result.append((track["name"], current))
    return result


def matrix(frame: dict) -> tuple[float, float, float, float, float, float]:
    # PopCap's skew fields are degrees, with its clockwise Y-axis convention.
    kx, ky = math.radians(frame["kx"]), math.radians(frame["ky"])
    return (math.cos(kx) * frame["sx"], math.sin(kx) * frame["sx"],
            -math.sin(ky) * frame["sy"], math.cos(ky) * frame["sy"], frame["x"], frame["y"])


def render_pose(animation: dict, index: int, loaded: dict, canvas: tuple[int, int], offset=(0, 0)) -> Image.Image:
    output = Image.new("RGBA", canvas, (0, 0, 0, 0))
    for _, frame in pose(animation, index):
        original = loaded[frame["i"]].copy()
        if frame["a"] < 1:
            original.putalpha(original.getchannel("A").point(lambda alpha: round(alpha * frame["a"])))
        a, b, c, d, x, y = matrix(frame)
        determinant = a * d - b * c
        if abs(determinant) < 0.0000001:
            continue
        x += offset[0]
        y += offset[1]
        inverse = (d / determinant, -c / determinant, (c * y - d * x) / determinant,
                   -b / determinant, a / determinant, (b * x - a * y) / determinant)
        layer = original.transform(canvas, Image.Transform.AFFINE, inverse, resample=Image.Resampling.BICUBIC)
        output.alpha_composite(layer)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    arguments = parser.parse_args()
    cache = arguments.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    archive_path = cache / "github.zip"
    if not archive_path.exists():
        print("Downloading pinned original macOS asset archive...", flush=True)
        response = requests.get(ARCHIVE_URL, timeout=(15, 90))
        response.raise_for_status()
        if not response.content.startswith(b"PK"):
            raise ValueError("Source did not return a ZIP archive")
        archive_path.write_bytes(response.content)
    archive_data = archive_path.read_bytes()
    expected_archive_sha256 = "7ddc13270a7dd7cad789d98d8d89ca7906069238c85d77a5413c23d00b64501d"
    if sha256(archive_data) != expected_archive_sha256:
        raise ValueError("Archive SHA-256 differs from the verified, pinned original asset archive")
    archive = zipfile.ZipFile(io.BytesIO(archive_data))
    prefix = archive.namelist()[0].split("/")[0] + "/"
    paths = {name[len(prefix):]: name for name in archive.namelist() if not name.endswith("/")}
    by_stem = {}
    for path in paths:
        item = Path(path)
        if item.suffix.lower() in (".png", ".jpg", ".jpeg"):
            by_stem.setdefault((item.parent.as_posix(), item.stem.upper()), []).append(path)
    assets = ROOT / "frontend" / "public" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    animations = {}
    source_records = {}
    loaded_images = {}
    manifest = {"canvasWidth": 800, "canvasHeight": 600, "images": {}, "imageDimensions": {}, "aliases": {},
                "animations": "animations.json", "fonts": {}, "sounds": {}, "sourceCommit": COMMIT}

    def read(path: str) -> bytes:
        data = archive.read(paths[path])
        source_records[path] = {"url": f"https://github.com/{REPOSITORY}/blob/{COMMIT}/{path}",
                                "sha256": sha256(data), "bytes": len(data)}
        return data

    def add_image(path: str, key: str) -> None:
        if key in manifest["images"]:
            return
        original = Image.open(io.BytesIO(read(path))).convert("RGBA")
        mask_path = str(Path(path).with_name(Path(path).stem + "_.png")).replace("\\", "/")
        if Path(path).suffix.lower() in (".jpg", ".jpeg") and mask_path in paths:
            mask = Image.open(io.BytesIO(read(mask_path))).convert("L")
            if mask.size != original.size:
                raise ValueError(f"Alpha mask dimensions differ for {path}")
            original.putalpha(mask)
        relative = "images/" + key + ".png"
        destination = assets / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        original.save(destination, optimize=True)
        loaded_images[key] = original
        manifest["images"][key] = relative
        manifest["imageDimensions"][key] = {"width": original.width, "height": original.height}

    for key, source in ANIMATIONS.items():
        data = read(source)
        animations[key] = parse_animation(data, source)
        raw_destination = assets / "original" / source
        raw_destination.parent.mkdir(parents=True, exist_ok=True)
        raw_destination.write_bytes(data)
        references = {frame["i"] for track in animations[key]["tracks"] for frame in track["frames"] if frame.get("i")}
        for reference in sorted(references):
            directory, stem = ("reanim", reference[len("IMAGE_REANIM_"):]) if reference.startswith("IMAGE_REANIM_") else ("images", reference[len("IMAGE_"):])
            matches = by_stem.get((directory, stem), [])
            if not matches:
                raise ValueError(f"Unresolved original image: {reference}")
            chosen = sorted(matches, key=lambda match: (Path(match).suffix.lower() != ".png", match))[0]
            add_image(chosen, reference)
        print(key, "frames", animations[key]["frameCount"], "ranges", animations[key]["ranges"], flush=True)

    for path in UI:
        if path not in paths:
            raise ValueError(f"Missing required UI asset: {path}")
        add_image(path, "IMAGE_" + Path(path).stem.upper())
    for path in paths:
        item = Path(path)
        if item.parent.as_posix() == "data" and any(item.stem.startswith(prefix) for prefix in FONT_PREFIXES):
            destination = assets / "fonts" / item.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(read(path))
            manifest["fonts"][item.name] = "fonts/" + item.name
        if item.parent.as_posix() == "sounds" and item.suffix == ".ogg" and item.stem.lower() in SOUNDS:
            destination = assets / "sounds" / item.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(read(path))
            manifest["sounds"][item.stem] = "sounds/" + item.name

    manifest["aliases"] = {"treefood": "IMAGE_TREEFOOD", "speech": "IMAGE_STORE_SPEECHBUBBLE2", "coinbank": "IMAGE_COINBANK",
                           "shop": "IMAGE_ZENSHOPBUTTON", "shopHover": "IMAGE_ZENSHOPBUTTON_HIGHLIGHT",
                           "nextGarden": "IMAGE_ZEN_NEXTGARDEN", "coin": "IMAGE_REANIM_COIN_GOLD_DOLLAR"}
    for name, animation in animations.items():
        for track in animation["tracks"]:
            for frame in track["frames"]:
                if frame.get("i") and frame["i"] not in manifest["images"]:
                    raise ValueError(f"Missing referenced image in {name}")

    # Assemble the original garden-pot pose, without drawing new artwork.
    pot = animations["pot"]
    start = pot["ranges"].get("anim_zengarden", {"start": 0})["start"]
    pot_canvas = render_pose(pot, start, loaded_images, (256, 256), (64, 64))
    bounds = pot_canvas.getbbox()
    if not bounds:
        raise ValueError("Original garden pot pose has no pixels")
    pot_image = pot_canvas.crop(bounds)
    pot_image.save(assets / "images" / "empty-pot.png", optimize=True)
    manifest["images"]["EMPTY_POT"] = "images/empty-pot.png"
    manifest["imageDimensions"]["EMPTY_POT"] = {"width": pot_image.width, "height": pot_image.height}
    manifest["aliases"]["emptyPot"] = "EMPTY_POT"
    manifest["potPose"] = {"animation": "pot", "range": "anim_zengarden", "frame": start,
                            "crop": list(bounds), "renderOffset": [64, 64]}

    stages = {"start": {"range": "anim_start", **animations["tree"]["ranges"]["anim_start"]},
              "growth": [{"height": number, "range": f"anim_grow{number}", **animations["tree"]["ranges"][f"anim_grow{number}"]}
                         for number in range(1, 52)]}
    stages["originalBehavior"] = {"loadedHeightMaximum": 50, "feedHeightMaximum": 51, "growthFramesPerSecond": 8,
                                   "treeOffset": [0.5, 0.5], "treefoodOffset": [340, 300], "cloudFramesPerSecond": 0.2,
                                   "renderOrder": ["bg", "clouds", "tree", "grass", "overlay/leaf/bunch"],
                                   "speechImage": "IMAGE_STORE_SPEECHBUBBLE2",
                                   "speechPositions": [{"heightBelow": 7, "x": 400, "y": 152},
                                                       {"heightBelow": 12, "x": 395, "y": 60},
                                                       {"heightBelow": None, "x": 390, "y": 52}]}
    dump(assets / "animations.json", {"canvasWidth": 800, "canvasHeight": 600, "animations": animations, "stages": stages})
    dump(assets / "manifest.json", manifest)
    source_manifest = {"repository": f"https://github.com/{REPOSITORY}", "edition": "original macOS (not Replanted)",
                       "commit": COMMIT, "archive": {"url": ARCHIVE_URL, "sha256": sha256(archive_data), "bytes": len(archive_data)},
                       "sources": source_records, "transformations": ["XML sparse transform tracks parsed to JSON; empty fields inherit",
                       "JPEG + matching underscore PNG alpha mask reconstructed as RGBA PNG", "Garden-pot pose composed from original Pot.reanim layers"],
                       "alternatePublicIndex": "https://www.spriters-resource.com/pc_computer/plantsvszombies/asset/29115/page-2/",
                       "alternateDownloadResult": "HTTP 403; no assets obtained from this source"}
    dump(assets / "sources.json", source_manifest)
    preview_folder = cache / "previews"
    preview_folder.mkdir(exist_ok=True)
    for height in (0, 1, 5, 10, 25, 50, 51):
        name = "anim_start" if height == 0 else f"anim_grow{height}"
        index = animations["tree"]["ranges"][name]["end"]
        render_pose(animations["tree"], index, loaded_images, (800, 600)).save(preview_folder / f"tree-height-{height}.png")
    print("Imported", len(manifest["images"]), "original image keys;", len(source_records), "source files.", flush=True)
    print("Preview folder", preview_folder, flush=True)


if __name__ == "__main__":
    main()
