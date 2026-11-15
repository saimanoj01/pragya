#!/usr/bin/env python3
"""Delegating entrypoint so .agents/skills/pragya-companion/scripts/pragya_cli.py
runs the canonical scripts/pragya_cli.py from any current working directory.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path


def _find_repo_cli() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "scripts" / "pragya_cli.py"
        if candidate.is_file() and candidate.resolve() != here:
            return candidate.resolve()
    raise FileNotFoundError("Could not locate canonical scripts/pragya_cli.py")


if __name__ == "__main__":
    target = _find_repo_cli()
    sys.argv[0] = str(target)
    runpy.run_path(str(target), run_name="__main__")
