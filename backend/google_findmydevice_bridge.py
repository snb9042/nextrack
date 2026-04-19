#!/usr/bin/env python3
"""
google_findmydevice_bridge.py — Google Find My Device via Selenium

First-time setup:
  pip install selenium webdriver-manager
  python google_findmydevice_bridge.py --login
  → Chrome opens, log into your Google account, then close it.
  → Subsequent runs are headless and automatic.

The Chrome profile is saved in .chrome_findmy_profile/ so you only
log in once. Re-run --login if Google logs you out.
"""

import sys
import json
import os
import time

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.path.join(SCRIPT_DIR, '.chrome_findmy_profile')
FIND_MY_URL = 'https://findmydevice.google.com/'
LOGIN_MODE  = '--login' in sys.argv


def out(obj):
    print(json.dumps(obj))


def find_devices_in_json(data, seen, depth=0):
    """Recursively scan any JSON structure for records containing lat+lng."""
    found = []
    if depth > 12:
        return found

    if isinstance(data, dict):
        lat = data.get('latitude') or data.get('lat')
        lng = data.get('longitude') or data.get('lng') or data.get('lon')
        if (isinstance(lat, (int, float)) and isinstance(lng, (int, float))
                and abs(lat) <= 90 and abs(lng) <= 180 and (lat != 0 or lng != 0)):
            dev_id = str(data.get('id') or data.get('deviceId') or data.get('name') or f'gfmd-{lat:.5f}-{lng:.5f}')
            if dev_id not in seen:
                seen.add(dev_id)
                ts = data.get('timestamp') or data.get('timeStamp') or data.get('lastSeen')
                found.append({
                    'id':            dev_id,
                    'name':          data.get('name') or data.get('deviceName') or data.get('model') or 'Google Device',
                    'model':         data.get('model') or data.get('deviceModel') or '',
                    'batteryLevel':  data.get('batteryLevel') or data.get('battery'),
                    'batteryStatus': None,
                    'location': {
                        'latitude':           lat,
                        'longitude':          lng,
                        'horizontalAccuracy': data.get('accuracy') or data.get('horizontalAccuracy'),
                        'altitude':           data.get('altitude'),
                        'speed':              None,
                        'locationType':       'gps',
                        'timeStamp':          ts,
                        'isOld':              False,
                        'isInaccurate':       False,
                    },
                })
        for v in data.values():
            found.extend(find_devices_in_json(v, seen, depth + 1))

    elif isinstance(data, list):
        for item in data:
            found.extend(find_devices_in_json(item, seen, depth + 1))

    return found


def harvest_network(driver):
    """Capture all XHR responses from the performance log and scan for devices."""
    devices, seen = [], set()
    try:
        logs = driver.get_log('performance')
    except Exception:
        return devices

    for entry in logs:
        try:
            msg = __import__('json').loads(entry['message'])['message']
            if msg.get('method') != 'Network.responseReceived':
                continue
            url = msg.get('params', {}).get('response', {}).get('url', '')
            # Only look at Find My Device and Google RPC calls
            if not any(k in url for k in ['findmydevice', 'batchexecute', 'android/find', 'locationsharing']):
                continue
            req_id = msg['params']['requestId']
            try:
                body = driver.execute_cdp_cmd('Network.getResponseBody', {'requestId': req_id})
                text = body.get('body', '')
                # Google RPC responses start with )]}'\n
                if text.startswith(")]}'\n"):
                    text = text[5:]
                data = __import__('json').loads(text)
                devices.extend(find_devices_in_json(data, seen))
            except Exception:
                pass
        except Exception:
            pass

    return devices


def main():
    # ── Dependency check ──────────────────────────────────────────────────────
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
    except ImportError:
        out({'ok': False, 'needs_install': True,
             'error': 'selenium not installed',
             'fix': 'pip install selenium webdriver-manager'})
        sys.exit(1)

    profile_exists = os.path.isdir(PROFILE_DIR)

    if not profile_exists and not LOGIN_MODE:
        out({'ok': False, 'needs_login': True,
             'error': 'Chrome profile not set up yet',
             'fix': 'Run once: python backend/google_findmydevice_bridge.py --login'})
        sys.exit(0)

    # ── Chrome options ────────────────────────────────────────────────────────
    options = Options()
    options.add_argument(f'--user-data-dir={PROFILE_DIR}')
    options.add_argument('--profile-directory=Default')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-blink-features=AutomationControlled')
    options.add_experimental_option('excludeSwitches', ['enable-automation'])
    options.add_experimental_option('useAutomationExtension', False)
    options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})

    headless = profile_exists and not LOGIN_MODE
    if headless:
        options.add_argument('--headless=new')
        options.add_argument('--window-size=1280,900')

    # ── Launch Chrome ─────────────────────────────────────────────────────────
    driver = None
    try:
        try:
            from webdriver_manager.chrome import ChromeDriverManager
            from selenium.webdriver.chrome.service import Service
            driver = webdriver.Chrome(
                service=Service(ChromeDriverManager().install()),
                options=options,
            )
        except Exception:
            driver = webdriver.Chrome(options=options)  # fallback: chromedriver in PATH
    except Exception as e:
        out({'ok': False, 'needs_install': True,
             'error': f'ChromeDriver not found: {e}',
             'fix': 'Install Chrome and run: pip install webdriver-manager'})
        sys.exit(1)

    try:
        driver.get(FIND_MY_URL)

        # ── Login mode: wait for user to authenticate ─────────────────────────
        if LOGIN_MODE:
            if 'accounts.google.com' in driver.current_url or 'myaccount.google.com' in driver.current_url:
                print('[NexTrack] Log into your Google account in the Chrome window that opened.')
                print('[NexTrack] Navigate to findmydevice.google.com, wait for your devices to appear,')
                print('[NexTrack] then close the Chrome window (or press Enter here).')
                try:
                    input('[NexTrack] Press Enter when done...')
                except EOFError:
                    time.sleep(30)
            out({'ok': True, 'devices': [], 'message': 'Login profile saved — restart the server to begin syncing'})
            driver.quit()
            sys.exit(0)

        # ── Wait for page to load / detect login redirect ─────────────────────
        deadline = time.time() + 20
        while time.time() < deadline:
            if 'accounts.google.com' in driver.current_url:
                out({'ok': False, 'needs_login': True,
                     'error': 'Google session expired',
                     'fix': 'Run: python backend/google_findmydevice_bridge.py --login'})
                driver.quit()
                sys.exit(0)
            if 'findmydevice.google.com' in driver.current_url:
                break
            time.sleep(0.5)

        # Give the page time to make its API calls
        time.sleep(8)

        # ── Extract devices from network log ──────────────────────────────────
        devices = harvest_network(driver)

        if not devices:
            # Last-resort: try JavaScript extraction from page state
            try:
                raw = driver.execute_script('''
                    const state = window.__INITIAL_STATE__ || window.__STATE__ || window.APP_INITIALIZATION_STATE;
                    return state ? JSON.stringify(state) : null;
                ''')
                if raw:
                    import json as _j
                    devices = find_devices_in_json(_j.loads(raw), set())
            except Exception:
                pass

        driver.quit()
        out({'ok': True, 'devices': devices, 'source': 'find_my_device'})

    except Exception as e:
        try:
            driver.quit()
        except Exception:
            pass
        out({'ok': False, 'error': str(e), 'transient': True})
        sys.exit(1)


if __name__ == '__main__':
    main()
