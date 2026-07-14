"""Create a transparent pilot summary from pseudonymised verification results."""
from __future__ import annotations

import csv
import sys
from collections import Counter


NEGATIVE = {"impostor", "print_attack", "screen_photo", "screen_video", "synthetic_video"}


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: summarise_pilot_results.py testing/results.csv")
        return 2
    with open(sys.argv[1], newline="") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        print("No results found.")
        return 1
    counts = Counter(row["attempt_type"] for row in rows)
    approved = Counter(row["attempt_type"] for row in rows if row["decision"] == "approved")
    genuine = [r for r in rows if r["attempt_type"] == "genuine"]
    negative = [r for r in rows if r["attempt_type"] in NEGATIVE]
    false_rejects = sum(r["decision"] != "approved" for r in genuine)
    false_accepts = sum(r["decision"] == "approved" for r in negative)
    print("BIOCHECK PILOT SUMMARY")
    print(f"Attempts: {len(rows)}")
    for kind in sorted(counts):
        print(f"{kind}: {counts[kind]} total, {approved[kind]} approved")
    if genuine:
        print(f"FRR: {false_rejects / len(genuine):.4%} ({false_rejects}/{len(genuine)})")
    if negative:
        print(f"FAR/APCER proxy: {false_accepts / len(negative):.4%} ({false_accepts}/{len(negative)})")
    print("This is a pilot summary, not a certification result.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
