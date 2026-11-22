#!/usr/bin/python3
"""Serve new testnet page loads only while both local APIs agree on the tip."""

import pathlib
import time
import urllib.request

MARKER = pathlib.Path('/run/verge-explorer-testnet-site-gate/ready')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def height(url):
    with OPENER.open(url, timeout=1.5) as response:
        if response.status != 200:
            raise ValueError('non-200 response')
        value = response.read(32).decode('ascii').strip()
    if not value.isdecimal():
        raise ValueError('non-numeric height')
    return int(value)


def healthy():
    indexer = height('http://127.0.0.1:3011/blocks/tip/height')
    backend = height('http://127.0.0.1:9009/api/v1/blocks/tip/height')
    return indexer > 0 and abs(indexer - backend) <= 2


def main():
    MARKER.unlink(missing_ok=True)
    previous = None
    while True:
        try:
            ready = healthy()
        except Exception:
            ready = False
        if ready:
            MARKER.touch(mode=0o644, exist_ok=True)
        else:
            MARKER.unlink(missing_ok=True)
        if ready != previous:
            print('Testnet explorer public gate: ' + ('live' if ready else 'maintenance'), flush=True)
            previous = ready
        time.sleep(3)


if __name__ == '__main__':
    main()
