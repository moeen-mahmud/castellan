#!/usr/bin/env python3
"""Profile a CSV: row count, and per column type, null rate and top values.

Standard library only, on purpose. A skill script that needs a dependency needs a pyproject.toml, and
that turns every call into `uv run` with an environment to create — worth it for real work, and not
for this.
"""

import csv
import sys
from collections import Counter


def looks_numeric(value: str) -> bool:
    try:
        float(value)
        return True
    except ValueError:
        return False


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: profile.py <path to csv>", file=sys.stderr)
        return 2

    path = argv[1]
    try:
        with open(path, newline="", encoding="utf-8") as handle:
            sample = handle.read(8192)
            handle.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
            except csv.Error:
                print(
                    f"{path}: cannot determine the delimiter — this may not be a delimited file.",
                    file=sys.stderr,
                )
                return 1
            reader = csv.DictReader(handle, dialect=dialect)
            if reader.fieldnames is None:
                print(f"{path}: no header row.", file=sys.stderr)
                return 1
            columns = {name: Counter() for name in reader.fieldnames}
            rows = 0
            for row in reader:
                rows += 1
                for name in reader.fieldnames:
                    columns[name][(row.get(name) or "").strip()] += 1
    except UnicodeDecodeError:
        print(f"{path}: not valid UTF-8. Re-encode it before profiling.", file=sys.stderr)
        return 1
    except FileNotFoundError:
        print(f"{path}: no such file.", file=sys.stderr)
        return 1

    print(f"rows: {rows}")
    print(f"columns: {len(columns)}")
    print()
    for name, counts in columns.items():
        missing = counts.get("", 0)
        present = [value for value in counts.elements() if value != ""]
        kind = "numeric" if present and all(looks_numeric(v) for v in present) else "text"
        top = ", ".join(
            f"{value!r} x{count}" for value, count in counts.most_common(4) if value != ""
        )
        share = 0 if rows == 0 else round(missing * 100 / rows)
        print(f"{name}")
        print(f"  type     {kind}")
        print(f"  missing  {missing} of {rows} ({share}%)")
        print(f"  common   {top or '(none)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
