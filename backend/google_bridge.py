#!/usr/bin/env python3
"""
google_bridge.py — fetches Google Find My Device / Location Sharing devices
Uses locationsharinglib (cookie-based auth — most reliable approach)

Setup:
  1. py -m pip install locationsharinglib
  2. Log into Google in Chrome
  3. Install Chrome extension "Get cookies.txt LOCALLY"
  4. Visit maps.google.com → click extension → Export cookies
  5. Save file as: backend/google_cookies.txt
  6. npm start  (server picks it up automatically)
"""

import sys, json, os

COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'google_cookies.txt')

def main():
    try:
        from locationsharinglib import Service
    except ImportError:
        print(json.dumps({
            "ok": False, "needs_install": True,
            "error": "locationsharinglib not installed",
            "fix": "py -m pip install locationsharinglib"
        }))
        sys.exit(1)

    if not os.path.exists(COOKIES_FILE):
        print(json.dumps({
            "ok": False, "needs_cookies": True,
            "error": "google_cookies.txt not found",
            "fix": (
                "1. Install Chrome extension 'Get cookies.txt LOCALLY'\n"
                "2. Go to maps.google.com while logged into Google\n"
                "3. Click the extension icon → Export → save as backend/google_cookies.txt"
            )
        }))
        sys.exit(0)

    email = sys.argv[1] if len(sys.argv) > 1 else None

    try:
        service = Service(cookies_file=COOKIES_FILE, authenticating_account=email)
    except Exception as e:
        err = str(e)
        if any(k in err.lower() for k in ['cookie', 'expired', 'auth', 'invalid']):
            print(json.dumps({
                "ok": False, "needs_cookies": True,
                "error": f"Cookies expired: {err}",
                "fix": "Re-export fresh cookies.txt from maps.google.com"
            }))
        else:
            print(json.dumps({"ok": False, "error": err}))
        sys.exit(1)

    devices_out = []
    try:
        for person in service.get_all_people():
            try:
                ts = None
                try:
                    ts = int(person.datetime.timestamp() * 1000)
                except: pass

                devices_out.append({
                    "id":     person.id,
                    "name":   person.full_name or person.nickname or "Google Device",
                    "model":  "Android / Google Tag",
                    "source": "google",
                    "batteryLevel": None,
                    "location": {
                        "latitude":           person.latitude,
                        "longitude":          person.longitude,
                        "horizontalAccuracy": getattr(person, 'accuracy', None),
                        "timeStamp":          ts,
                        "locationType":       "gps",
                        "address":            getattr(person, 'address', None),
                    } if getattr(person, 'latitude', None) and getattr(person, 'longitude', None) else None,
                })
            except Exception:
                pass
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Failed to fetch: {e}"}))
        sys.exit(1)

    print(json.dumps({
        "ok": True,
        "devices": devices_out,
        "note": f"Found {len(devices_out)} device(s) via Google Location Sharing"
    }))

if __name__ == "__main__":
    main()
