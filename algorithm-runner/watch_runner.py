"""Restart the credentialless runner when its mounted Python source changes."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).with_name("runner.py")
stopping = False
child: subprocess.Popen[bytes] | None = None


def stop(_signum: int | None = None, _frame: object | None = None) -> None:
    global stopping
    stopping = True
    stop_child()


def stop_child() -> None:
    global child
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def main() -> None:
    global child
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    observed = SOURCE.stat().st_mtime_ns
    while not stopping:
        child = subprocess.Popen([sys.executable, str(SOURCE)], env=os.environ.copy())
        while not stopping and child.poll() is None:
            time.sleep(0.25)
            current = SOURCE.stat().st_mtime_ns
            if current != observed:
                observed = current
                print("[openleek-watch] runner.py changed; restarting", flush=True)
                stop_child()
        if not stopping and child.returncode is not None:
            time.sleep(0.5)


if __name__ == "__main__":
    main()
