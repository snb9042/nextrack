#!/usr/bin/env python3
"""
icloud_bridge.py — fetches all Find My devices via pyicloud
Usage:
  echo "<password>" | python icloud_bridge.py <email>        # first run: may prompt for 2FA
  echo "<password>" | python icloud_bridge.py <email> <code> # submit 2FA code

Password is read from stdin to keep it out of process listings.

Outputs a single JSON line to stdout:
  { "ok": true, "devices": [...] }
  { "ok": false, "error": "...", "needs2FA": true }
"""

import sys
import json
import os

def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print(json.dumps({"ok": False, "error": "Usage: echo <password> | icloud_bridge.py <email> [2fa_code]"}))
        sys.exit(1)

    email    = args[0]
    password = sys.stdin.readline().strip()
    code_2fa = args[1] if len(args) > 1 else None

    if not password:
        print(json.dumps({"ok": False, "error": "Password required via stdin"}))
        sys.exit(1)

    try:
        from pyicloud import PyiCloudService
    except ImportError:
        print(json.dumps({
            "ok": False,
            "error": "pyicloud not installed. Run: pip install pyicloud",
            "needs_install": True
        }))
        sys.exit(1)

    # Cookie directory — persists session so 2FA only needed once
    cookie_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.icloud_cookies')
    os.makedirs(cookie_dir, exist_ok=True)

    try:
        api = PyiCloudService(email, password, cookie_directory=cookie_dir)
    except Exception as e:
        err = str(e)
        transient = '503' in err or 'Service Temporarily Unavailable' in err or 'Temporarily' in err
        print(json.dumps({"ok": False, "error": err, "transient": transient}))
        sys.exit(1)

    # Handle 2FA
    if api.requires_2fa:
        if code_2fa:
            result = api.validate_2fa_code(code_2fa)
            if not result:
                print(json.dumps({"ok": False, "error": "Invalid 2FA code", "needs2FA": True}))
                sys.exit(1)
            # Trust this device so we don't need 2FA next time
            if not api.is_trusted_session:
                api.trust_session()
        else:
            print(json.dumps({
                "ok": False,
                "needs2FA": True,
                "error": "2FA required — POST /api/apple/2fa with the 6-digit code from your iPhone"
            }))
            sys.exit(0)
    elif api.requires_2sa:
        if code_2fa:
            devices = api.trusted_devices
            device  = devices[0] if devices else None
            if device:
                api.send_verification_code(device)
                result = api.validate_verification_code(device, code_2fa)
                if not result:
                    print(json.dumps({"ok": False, "error": "Invalid 2SA code", "needs2FA": True}))
                    sys.exit(1)
        else:
            print(json.dumps({
                "ok": False,
                "needs2FA": True,
                "error": "2-step auth required — run again with the verification code as third argument"
            }))
            sys.exit(0)

    # Fetch all Find My devices
    devices_out = []
    try:
        for item in api.devices:
            try:
                location = item.location()

                dev = {
                    "id":           item.data.get("id", ""),
                    "name":         item.data.get("name", "Unknown"),
                    "model":        item.data.get("deviceDisplayName", ""),
                    "batteryLevel": item.data.get("batteryLevel"),
                    "batteryStatus":item.data.get("batteryStatus"),
                    "location":     None,
                }

                if location:
                    dev["location"] = {
                        "latitude":           location.get("latitude"),
                        "longitude":          location.get("longitude"),
                        "horizontalAccuracy": location.get("horizontalAccuracy"),
                        "altitude":           location.get("altitude"),
                        "speed":              location.get("speed"),
                        "locationType":       location.get("locationType"),
                        "timeStamp":          location.get("timeStamp"),
                        "isOld":              location.get("isOld", False),
                        "isInaccurate":       location.get("isInaccurate", False),
                    }

                devices_out.append(dev)
            except Exception as item_err:
                # Don't let one bad device kill the whole response
                devices_out.append({"id": "error", "name": "error", "error": str(item_err), "location": None})
    except Exception as e:
        err = str(e)
        transient = '503' in err or 'Service Temporarily Unavailable' in err or 'Temporarily' in err
        print(json.dumps({"ok": False, "error": f"Failed to fetch devices: {err}", "transient": transient}))
        sys.exit(1)

    print(json.dumps({"ok": True, "devices": devices_out}))

if __name__ == "__main__":
    main()
