#!/usr/bin/env python3
"""
apple_cookies_bridge.py — Apple Find My via browser cookies (no password needed)

Setup:
  1. Install Chrome extension "Get cookies.txt LOCALLY"
  2. Go to icloud.com and log in fully
  3. Click the extension icon → Export → save as backend/apple_cookies.txt
  4. Restart the server

Password/SRP auth is bypassed entirely — uses the same session Apple's
web app uses, so no 503 SRP errors.

Outputs a single JSON line to stdout (same schema as icloud_bridge.py):
  { "ok": true, "devices": [...] }
  { "ok": false, "error": "...", "needs_cookies": true }
"""

import sys
import json
import os
from http.cookiejar import MozillaCookieJar

COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'apple_cookies.txt')

HEADERS = {
    'Origin':       'https://www.icloud.com',
    'Referer':      'https://www.icloud.com/',
    'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':       'application/json',
    'Content-Type': 'application/json',
}

INIT_PAYLOAD = {
    "clientContext": {
        "appName":           "iCloud Find (Web)",
        "appVersion":        "2.0",
        "apiVersion":        "3.0",
        "deviceListVersion": 1,
        "fmly":              True,
        "shouldLocate":      True,
        "selectedDevice":    "all",
        "timezone":          "UTC",
    }
}

def is_transient(status_code, err=""):
    return status_code in (502, 503, 504) or 'timeout' in str(err).lower()

def main():
    try:
        import requests
    except ImportError:
        print(json.dumps({"ok": False, "error": "requests not installed — run: pip install requests", "needs_install": True}))
        sys.exit(1)

    if not os.path.exists(COOKIES_FILE):
        print(json.dumps({
            "ok": False,
            "needs_cookies": True,
            "error": "apple_cookies.txt not found",
            "fix": (
                "1. Install Chrome extension 'Get cookies.txt LOCALLY'\n"
                "2. Go to icloud.com and log in\n"
                "3. Click extension icon → Export → save as backend/apple_cookies.txt"
            )
        }))
        sys.exit(0)

    # Load Netscape cookie file
    jar = MozillaCookieJar(COOKIES_FILE)
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to load apple_cookies.txt: {e}"}))
        sys.exit(1)

    session = requests.Session()
    session.cookies = requests.cookies.RequestsCookieJar()
    for cookie in jar:
        session.cookies.set(cookie.name, cookie.value, domain=cookie.domain, path=cookie.path)

    # Step 1 — validate session & discover Find My service URL
    try:
        validate = session.post(
            "https://setup.icloud.com/setup/ws/1/validate",
            json={},
            headers=HEADERS,
            timeout=20,
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Network error: {e}", "transient": True}))
        sys.exit(1)

    if validate.status_code in (401, 403):
        print(json.dumps({
            "ok": False, "needs_cookies": True,
            "error": "iCloud cookies expired — re-export from icloud.com"
        }))
        sys.exit(1)

    if validate.status_code != 200:
        print(json.dumps({
            "ok": False,
            "error": f"iCloud validate returned {validate.status_code}",
            "transient": is_transient(validate.status_code),
        }))
        sys.exit(1)

    try:
        account = validate.json()
    except Exception:
        print(json.dumps({"ok": False, "needs_cookies": True, "error": "iCloud returned unexpected response — cookies may be from wrong page. Export from icloud.com (not maps.google.com)"}))
        sys.exit(1)

    dsid = account.get('dsInfo', {}).get('dsid') or next(
        (c.value for c in jar if c.name == 'dsid'), None
    )

    findme_url = account.get('webservices', {}).get('findme', {}).get('url')
    if not findme_url:
        # Fallback to known endpoint pattern
        findme_url = 'https://fmipmobile.icloud.com'

    # Step 2 — call Find My initClient
    init_url = f"{findme_url}/fmipservice/client/web/initClient"
    params = {}
    if dsid:
        params['dsid'] = dsid

    try:
        resp = session.post(init_url, json=INIT_PAYLOAD, headers=HEADERS, params=params, timeout=30)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Find My request failed: {e}", "transient": True}))
        sys.exit(1)

    if resp.status_code in (401, 403):
        print(json.dumps({"ok": False, "needs_cookies": True, "error": "Find My auth failed — re-export cookies from icloud.com"}))
        sys.exit(1)

    if resp.status_code != 200:
        print(json.dumps({
            "ok": False,
            "error": f"Find My returned {resp.status_code}: {resp.text[:200]}",
            "transient": is_transient(resp.status_code),
        }))
        sys.exit(1)

    try:
        data = resp.json()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Bad JSON from Find My: {e}"}))
        sys.exit(1)

    # Parse device list
    devices_out = []
    for item in data.get('content', []):
        loc = item.get('location') or {}
        # API uses 'timestamp' (ms), bridge schema uses 'timeStamp'
        ts = loc.get('timestamp') or loc.get('timeStamp')

        dev = {
            "id":            item.get('id', ''),
            "name":          item.get('name', 'Unknown'),
            "model":         item.get('deviceDisplayName', item.get('deviceModel', '')),
            "batteryLevel":  item.get('batteryLevel'),
            "batteryStatus": item.get('batteryStatus'),
            "location":      None,
        }

        if loc.get('latitude') is not None and loc.get('longitude') is not None:
            dev["location"] = {
                "latitude":           loc.get('latitude'),
                "longitude":          loc.get('longitude'),
                "horizontalAccuracy": loc.get('horizontalAccuracy'),
                "altitude":           loc.get('altitude'),
                "speed":              loc.get('speed', -1),
                "locationType":       loc.get('locationType', 'gps'),
                "timeStamp":          ts,
                "isOld":              loc.get('isOld', False),
                "isInaccurate":       loc.get('isInaccurate', False),
            }

        devices_out.append(dev)

    print(json.dumps({"ok": True, "devices": devices_out, "source": "cookies"}))

if __name__ == "__main__":
    main()
