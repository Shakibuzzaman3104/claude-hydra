"""
@author Shakib
@since 15/10/26

Shared helpers: run the scripts in bin/ as subprocesses with the interpreter that runs pytest, so the tests behave the same on Windows.
"""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parents[2] / "bin"


def run_script(name, *args, stdin=None, env=None):
    """Runs bin/<name> and returns the finished process (text output, UTF-8)."""
    return subprocess.run(
        [sys.executable, "-I", str(BIN / name), *map(str, args)],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=60,
    )


def load_script(name):
    """Imports bin/<name> (its file names have hyphens) so a test can call its functions."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), BIN / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_symlink(link, target):
    """Creates a symlink, or skips the test where the platform will not allow it (Windows without developer mode)."""
    try:
        os.symlink(target, link, target_is_directory=Path(target).is_dir())
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
