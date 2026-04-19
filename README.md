# NexTrack 🛰️

**Unified AirTag + Android tag tracking** — one dashboard, both ecosystems, real data.

> Merges [FindTrack](https://github.com/snb9042/findtrack) (SQLite, geofencing, AI patterns) and TrackR (real auth bridges, WebSocket, timeline) into a production-ready app.

---

## Features

| | |
|---|---|
| 🍎 **Apple AirTag** | via pyicloud — the same library Home Assistant uses |
| 🤖 **Android tags** | via locationsharinglib — cookie-based Google auth |
| 🗺️ **Live map** | CartoDB dark tiles, Leaflet.js, no Maps API key required |
| ⏱️ **Timeline playback** | Scrub through full location history |
| 📍 **Geofencing** | Enter/exit alerts, click map to set coordinates |
| 🧠 **AI patterns** | Auto-detects Home, Work, Frequent Stops, Stationary |
| 🗄️ **SQLite persistence** | History survives restarts; JSON fallback if SQLite unavailable |
| 🔔 **Real-time alerts** | WebSocket push — significant moves, geofence triggers |
| 📊 **Analytics** | Distance, accuracy, source breakdown, sparklines |
| ⬇️ **Export** | CSV or JSON, with date range filter |

---

## Quick Start (Windows)

**1. Double-click `start.bat`** — installs deps and opens the server.

**2. Open your browser:** `http://localhost:3001`

That's it. The map loads immediately. Add credentials below to see your real devices.

---

## Apple AirTags

```powershell
py -m pip install -r backend/requirements.txt
```

Add to `backend/.env`:
```
APPLE_ICLOUD_EMAIL=you@icloud.com
APPLE_ICLOUD_PASSWORD=your_real_apple_id_password
```

> ⚠️ Use your **real Apple ID password**, not an App-Specific Password.

On first run, Apple will 2FA your iPhone. Submit the code:
```powershell
curl -X POST http://localhost:3001/api/apple/2fa `
  -H "Content-Type: application/json" `
  -d '{"code":"123456"}'
```

Session cookie is saved — subsequent restarts connect silently.

---

## Android Tags (Google)

```powershell
py -m pip install -r backend/requirements.txt
```

1. Install Chrome extension **"Get cookies.txt LOCALLY"**
2. Visit **maps.google.com** while logged in to your Google account
3. Click the extension → Export → save as `backend/google_cookies.txt`

Restart the server — Google devices appear automatically.

---

## Project Structure

```
nextrack/
├── start.bat              ← Windows one-click launcher
├── backend/
│   ├── server.js          ← Express + WebSocket + cron
│   ├── db.js              ← SQLite layer (JSON fallback if unavailable)
│   ├── icloud_bridge.py   ← Apple auth via pyicloud
│   ├── google_bridge.py   ← Google auth via locationsharinglib
│   ├── .env               ← Your credentials (not committed)
│   ├── nextrack.db        ← SQLite database (auto-created)
│   └── google_cookies.txt ← Drop here (not committed)
└── frontend/
    └── index.html         ← Complete single-file SPA
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/devices` | All devices |
| GET | `/api/devices/:id/history` | Location history (`?limit=300&from=&to=`) |
| GET | `/api/devices/:id/patterns` | AI-detected patterns |
| POST | `/api/sync/apple` | Force Apple sync now |
| POST | `/api/sync/google` | Force Google sync now |
| POST | `/api/apple/2fa` | Submit `{ "code": "123456" }` |
| GET | `/api/alerts` | All alerts |
| PATCH | `/api/alerts/read-all` | Mark all alerts read |
| GET/POST | `/api/geofences` | List / create geofences |
| DELETE | `/api/geofences/:id` | Remove a geofence |
| GET | `/api/export/:id` | Download history (`?format=csv\|json`) |
| GET | `/api/stats` | Per-device stats with total distance |
| GET | `/api/health` | Server health check |

---

## Compared to Predecessors

| Feature | FindTrack | TrackR | **NexTrack** |
|---|---|---|---|
| SQLite persistence | ✅ | ❌ | ✅ |
| JSON fallback | ❌ | ❌ | ✅ |
| Apple auth (working) | ❌ | ✅ | ✅ |
| Google auth (working) | ❌ | ✅ | ✅ |
| Geofencing UI | ❌ | ❌ | ✅ |
| AI pattern detection | ✅ concept | ❌ | ✅ working |
| Timeline playback | ❌ | ✅ | ✅ |
| WebSocket real-time | ❌ | ✅ | ✅ |
| Address display | ❌ | ❌ | ✅ |
| One-click Windows start | ❌ | ❌ | ✅ |

---

## Privacy

- Tracks only devices on your own accounts
- Credentials stored in `backend/.env` — never logged or transmitted
- Location data stays local in `nextrack.db`
- History auto-pruned after 30 days

---

*Built with Node.js · Leaflet.js · pyicloud · locationsharinglib*
