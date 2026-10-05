#!/usr/bin/env python3
"""Verify the complete Wisdom Tree key index without distributing game dialogue.

The optional archive path allows verification against the original source bytes:
  python scripts/verify-wisdom-corpus.py --archive /path/to/github.zip
"""

import argparse
import hashlib
import json
import re
import zipfile
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "backend" / "data"
EXPECTED_NUMBERS = (
    list(range(1, 50)) + list(range(101, 111)) + list(range(201, 206))
    + list(range(301, 306)) + list(range(401, 406))
    + [500, 600, 800, 900, 1000, 1100]
)
EXPECTED_KEYS = {f"TREE_OF_WISDOM_{n}" for n in EXPECTED_NUMBERS}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Original fixed-commit GitHub ZIP")
    args = parser.parse_args()
    quotes_raw = (DATA / "wisdom-tree-quotes.json").read_bytes()
    quotes = json.loads(quotes_raw)
    sources = json.loads((DATA / "wisdom-tree-sources.json").read_text(encoding="utf-8"))
    keys = [q["sourceKey"] for q in quotes]
    check(len(quotes) == 80, "The corpus must contain all 80 dialogue keys")
    check(len(set(q["id"] for q in quotes)) == 80, "Duplicate corpus ID")
    check(len(set(keys)) == 80, "Duplicate source key")
    check(set(keys) == EXPECTED_KEYS, "Missing or unexpected source keys")
    check(set(sources["sourceKeyHashes"]) == EXPECTED_KEYS, "Source hash index differs")
    check(sources["corpus"]["sha256"] == sha256(quotes_raw), "Corpus content hash differs")
    check(all(q.get("text", "").strip() for q in quotes), "Empty response text")
    check(all(q.get("textKind") in {"gameplay-summary", "original-chat"} for q in quotes),
          "Every response must identify its editorial status")
    check(all(isinstance(q["minHeight"], int) and q["minHeight"] > 0 for q in quotes),
          "Invalid original-height metadata")
    check(Counter(q["category"] for q in quotes) == Counter(sources["corpus"]["categories"]),
          "Category totals differ")

    source_verified = False
    if args.archive:
        archive_raw = args.archive.read_bytes()
        check(sha256(archive_raw) == sources["originalStrings"]["archiveSha256"],
              "Archive does not match the fixed source commit")
        with zipfile.ZipFile(args.archive) as archive:
            matches = [p for p in archive.namelist() if p.endswith("/properties/LawnStrings.txt")]
            check(len(matches) == 1, "Expected one original LawnStrings.txt")
            original_raw = archive.read(matches[0])
        check(sha256(original_raw) == sources["originalStrings"]["sha256"],
              "Original strings file hash differs")
        split = re.split(r"(?m)^\[([^\]\r\n]+)\]\s*$", original_raw.decode("cp1252"))
        numeric = {
            split[i]: split[i + 1].strip()
            for i in range(1, len(split), 2)
            if re.fullmatch(r"TREE_OF_WISDOM_\d+", split[i])
        }
        check(set(numeric) == EXPECTED_KEYS, "Original numeric dialogue keys differ")
        for key, original in numeric.items():
            check(sha256(original.encode("utf-8")) == sources["sourceKeyHashes"][key],
                  f"Original dialogue hash differs: {key}")
        source_verified = True

    print(json.dumps({
        "result": "pass", "entries": len(quotes), "distinctSourceKeys": len(set(keys)),
        "categories": dict(Counter(q["category"] for q in quotes)),
        "originalArchiveVerified": source_verified,
        "textStatus": "Chinese gameplay summaries and original chatter; no verbatim game transcript",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
