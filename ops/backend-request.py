"""Make an operator request without placing the backend bearer token in argv."""

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="Backend route, for example /api/health")
    parser.add_argument("--origin", default="http://127.0.0.1:8788")
    parser.add_argument("--token-file", required=True, type=Path)
    payload = parser.add_mutually_exclusive_group()
    payload.add_argument("--json", help="JSON body; selects POST")
    payload.add_argument("--json-file", type=Path, help="JSON body file; selects POST")
    args = parser.parse_args()
    if not args.path.startswith("/") or args.path.startswith("//"):
        parser.error("path must be a backend route beginning with one slash")
    token = args.token_file.read_text(encoding="utf-8").strip()
    if not token:
        parser.error("token file is empty")
    body = args.json_file.read_text(encoding="utf-8") if args.json_file else args.json
    data = None if body is None else json.dumps(json.loads(body)).encode("utf-8")
    request = urllib.request.Request(
        args.origin.rstrip("/") + args.path,
        data=data,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").replace(token, "[redacted]")
        print(f"HTTP {error.code}: {detail}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
