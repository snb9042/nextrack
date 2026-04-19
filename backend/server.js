/**
 * NexTrack v2 — server.js
 * Unified Apple Find My + Google Find Hub tracking
 */

const path      = require('path');
const { spawn } = require('child_process');
const fs        = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── Credentials ───────────────────────────────────────────────────────────────
const APPLE_EMAIL = process.env.APPLE_ICLOUD_EMAIL    || '';
const APPLE_PASS  = process.env.APPLE_ICLOUD_PASSWORD || '';
const GOOGLE_EMAIL= process.env.GOOGLE_EMAIL          || '';
const MAPS_KEY    = process.env.VITE_GOOGLE_MAPS_KEY  || '';
const PORT        = process.env.PORT                  || 3001;

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const cron      = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const db        = require('./db');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Serve frontend from ../frontend/
const FRONTEND = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND));

// ── Utilities ─────────────────────────────────────────────────────────────────
function iconForName(name = '') {
  const n = name.toLowerCase();
  if (n.includes('key'))                                     return '🔑';
  if (n.includes('bag')||n.includes('back')||n.includes('pack')) return '🎒';
  if (n.includes('wallet')||n.includes('card'))              return '👛';
  if (n.includes('bike')||n.includes('cycle'))               return '🚲';
  if (n.includes('car')||n.includes('vehicle'))              return '🚗';
  if (n.includes('phone')||n.includes('pixel')||n.includes('iphone')) return '📱';
  if (n.includes('laptop')||n.includes('mac'))               return '💻';
  if (n.includes('tag'))                                     return '🏷️';
  return '📍';
}
const COLORS = ['#2997ff','#30d158','#fbbc04','#ea4335','#bf5af2','#ff9f0a','#64d2ff','#ff375f'];

function haversineM(a, b) {
  const R=6371000, dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c=>{ if(c.readyState===WebSocket.OPEN) c.send(msg); });
}

function pushAlert(type, deviceId, data) {
  const a = {
    id: uuidv4(), type, device_id: deviceId,
    data: JSON.stringify(data),
    created_at: new Date().toISOString(),
  };
  db.insertAlert(a);
  broadcast({ event: 'alert', alert: {...a, data, read: false} });
}

// ── Ingest a location point ───────────────────────────────────────────────────
function ingestLocation(point) {
  const prev = db.getLatest(point.device_id);
  if (prev && prev.lat === point.lat && prev.lng === point.lng) return false;

  db.insertLocation(point);

  if (prev && haversineM(prev, point) > 50) {
    const dist = Math.round(haversineM(prev, point));
    const dev  = db.getAllDevices().find(d=>d.id===point.device_id);
    pushAlert('significant_move', point.device_id, {
      message: `${dev?.name||point.device_id} moved ${dist}m`,
      from: prev, to: point, distance: dist,
    });
  }

  checkGeofences(point.device_id, point);
  broadcast({ event: 'location_update', deviceId: point.device_id, location: point });
  return true;
}

// ── Geofence engine ───────────────────────────────────────────────────────────
const gfState = new Map(); // "deviceId:fenceId" → 'inside'|'outside'

function checkGeofences(deviceId, point) {
  db.getDeviceGeofences(deviceId).forEach(fence => {
    const key    = `${deviceId}:${fence.id}`;
    const dist   = haversineM({lat:fence.lat,lng:fence.lng}, point);
    const inside = dist <= fence.radius_m;
    const prev   = gfState.get(key);

    if (inside && prev !== 'inside') {
      gfState.set(key, 'inside');
      if (fence.notify_enter && prev !== undefined)
        pushAlert('geofence_enter', deviceId, { message: `Entered "${fence.name}"`, fence, location: point });
    } else if (!inside && prev === 'inside') {
      gfState.set(key, 'outside');
      if (fence.notify_exit)
        pushAlert('geofence_exit', deviceId, { message: `Left "${fence.name}"`, fence, location: point });
    } else if (prev === undefined) {
      gfState.set(key, inside ? 'inside' : 'outside');
    }
  });
}

// ── AI Pattern Analysis ───────────────────────────────────────────────────────
function analyzePatterns(deviceId) {
  const history = db.getHistory(deviceId, 500);
  if (history.length < 10) return;

  // Cluster by 80m proximity
  const clusters = [];
  history.forEach(loc => {
    let found = false;
    for (const c of clusters) {
      if (haversineM(c.center, loc) < 80) {
        c.points.push(loc);
        c.center.lat = c.points.reduce((s,p)=>s+p.lat,0)/c.points.length;
        c.center.lng = c.points.reduce((s,p)=>s+p.lng,0)/c.points.length;
        found = true; break;
      }
    }
    if (!found) clusters.push({ center:{lat:loc.lat,lng:loc.lng}, points:[loc] });
  });

  clusters.sort((a,b)=>b.points.length-a.points.length);
  const labels = ['Home','Work','Frequent Stop','Regular Visit'];

  clusters.slice(0,4).forEach((cluster, i) => {
    if (cluster.points.length < 3) return;
    const confidence = Math.min(0.95, cluster.points.length / history.length * 3);
    const hours = cluster.points.map(p=>new Date(p.timestamp).getHours());
    const avgHour = Math.round(hours.reduce((s,h)=>s+h,0)/hours.length);
    db.upsertPattern({
      id: `${deviceId}-cluster-${i}`,
      device_id: deviceId,
      type: i<2 ? 'frequent_location' : 'visited_place',
      label: `${labels[i]} (avg ${avgHour}:00)`,
      data: JSON.stringify({ center: cluster.center, visitCount: cluster.points.length, avgHour }),
      confidence: parseFloat(confidence.toFixed(2)),
      created_at: new Date().toISOString(),
    });
  });

  // Stationary detection
  const recent = history.slice(-20);
  if (recent.length > 5) {
    const maxDist = Math.max(...recent.map((p,i)=>i>0?haversineM(p,recent[0]):0));
    if (maxDist < 30) {
      const hoursStill = (Date.now()-new Date(recent[0].timestamp).getTime())/3600000;
      if (hoursStill > 2) {
        db.upsertPattern({
          id: `${deviceId}-stationary`,
          device_id: deviceId,
          type: 'stationary',
          label: `Stationary for ${Math.round(hoursStill)}h`,
          data: JSON.stringify({ since: recent[0].timestamp, location: recent[0], hours: Math.round(hoursStill) }),
          confidence: 0.9,
          created_at: new Date().toISOString(),
        });
      }
    }
  }
}

// ── Python bridge ─────────────────────────────────────────────────────────────
// Resolved once at startup — PYTHON_BIN env var overrides auto-detection
const PY_CANDIDATES = process.env.PYTHON_BIN
  ? [process.env.PYTHON_BIN]
  : ['py', 'python3', 'python'];

function runPython(script, args=[], { stdinData=null, timeoutMs=30000 }={}) {
  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= PY_CANDIDATES.length) return reject(new Error('No Python found — install Python 3.x'));
      const proc = spawn(PY_CANDIDATES[i], [script,...args], { cwd:__dirname, shell:false });
      let out='', err='', timedOut=false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        tryNext(i + 1);
      }, timeoutMs);

      proc.stdout.on('data', d=>out+=d);
      proc.stderr.on('data', d=>err+=d);
      proc.on('error', ()=>{ clearTimeout(timer); tryNext(i+1); });
      proc.on('close', code => {
        clearTimeout(timer);
        if (timedOut) return;
        if (err.trim()) process.stderr.write(err);
        if (code===9009||(code>0&&!out.trim())) return tryNext(i+1);
        try {
          const lines = out.trim().split('\n').filter(l=>l.startsWith('{'));
          if (!lines.length) return tryNext(i+1);
          resolve(JSON.parse(lines[lines.length-1]));
        } catch { tryNext(i+1); }
      });

      if (stdinData !== null) {
        proc.stdin.write(stdinData);
        proc.stdin.end();
      }
    };
    tryNext(0);
  });
}

// ── Apple sync ────────────────────────────────────────────────────────────────
const APPLE_BRIDGE = path.join(__dirname, 'icloud_bridge.py');
let applePending2FA  = false;
let appleLastSync    = 0;
let appleBackoffMs   = 0;     // extra delay after transient errors
let appleBackoffUntil = 0;

async function syncApple(twoFACode=null) {
  if (!twoFACode && Date.now() < appleBackoffUntil) return;
  if (!twoFACode && Date.now()-appleLastSync < 58000) return;
  if (applePending2FA && !twoFACode) {
    console.log('[Apple] Waiting for 2FA — POST /api/apple/2fa { "code": "XXXXXX" }');
    return;
  }
  if (!APPLE_PASS && !twoFACode) {
    console.warn('[Apple] No password set — add APPLE_ICLOUD_PASSWORD to backend/.env');
    return;
  }

  let result;
  try {
    // Password passed via stdin, not CLI args, to keep it out of process listings
    const args = [APPLE_EMAIL];
    if (twoFACode) args.push(twoFACode);
    result = await runPython(APPLE_BRIDGE, args, { stdinData: APPLE_PASS + '\n', timeoutMs: 60000 });
  } catch(e) { console.error('[Apple]', e.message); return; }

  if (!result.ok) {
    if (result.needs_install) { console.error('[Apple] Run: py -m pip install pyicloud'); return; }
    if (result.needs2FA) {
      applePending2FA = true;
      console.warn('\n⚠️  [Apple] 2FA required — check your iPhone, then:\n   curl -X POST http://localhost:3001/api/apple/2fa -H "Content-Type: application/json" -d "{\\"code\\":\\"123456\\"}"\n');
      return;
    }
    if (result.transient) {
      appleBackoffMs = Math.min((appleBackoffMs || 60000) * 2, 1800000); // 1m → 2m → 4m … max 30m
      appleBackoffUntil = Date.now() + appleBackoffMs;
      console.warn(`[Apple] Transient error — backing off ${Math.round(appleBackoffMs/60000)}m: ${result.error}`);
    } else {
      console.error('[Apple]', result.error);
    }
    return;
  }

  applePending2FA  = false;
  appleLastSync    = Date.now();
  appleBackoffMs   = 0;
  appleBackoffUntil = 0;
  const devices   = db.getAllDevices();
  let   newCount  = 0;

  (result.devices||[]).forEach((raw, i) => {
    // Stable fallback: hash name+model so order changes don't reshuffle IDs
    const stableKey = raw.name && raw.model ? `apple-${raw.name}-${raw.model}`.replace(/\s+/g,'-') : `apple-${i}`;
    const id   = raw.id   || stableKey;
    const name = raw.name || `AirTag ${i+1}`;
    const existing = devices.find(d=>d.id===id);

    db.upsertDevice({
      id, name, source:'apple',
      icon:           iconForName(name),
      color:          existing?.color || COLORS[devices.length % COLORS.length],
      status:         'active',
      battery_level:  raw.batteryLevel!=null ? Math.round(parseFloat(raw.batteryLevel)*100) : null,
      battery_status: raw.batteryStatus||null,
      model:          raw.model||null,
      last_seen:      new Date().toISOString(),
    });

    if (!existing) { console.log(`[Apple] ✅ Found: "${name}"`); newCount++; }

    const loc = raw.location;
    if (!loc?.latitude) { console.log(`[Apple] ⚠️  No location for "${name}"`); return; }

    ingestLocation({
      id: uuidv4(), device_id: id,
      timestamp:    loc.timeStamp ? new Date(loc.timeStamp).toISOString() : new Date().toISOString(),
      lat:          loc.latitude,
      lng:          loc.longitude,
      accuracy:     loc.horizontalAccuracy||null,
      altitude:     loc.altitude||null,
      speed:        loc.speed||null,
      source:       'apple',
      network_type: loc.locationType||'unknown',
      address:      null,
      is_old:       loc.isOld?1:0,
    });
  });

  if (newCount) broadcast({ event:'devices_updated', devices:db.getAllDevices() });
  db.getAllDevices().filter(d=>d.source==='apple').forEach(d=>{ try{analyzePatterns(d.id);}catch{} });
  console.log(`[Apple] Sync done — ${(result.devices||[]).length} devices`);
}

// ── Google sync ───────────────────────────────────────────────────────────────
const GOOGLE_BRIDGE  = path.join(__dirname, 'google_bridge.py');
const GOOGLE_COOKIES = path.join(__dirname, 'google_cookies.txt');
let   googleLastSync = 0;

async function syncGoogle() {
  if (Date.now()-googleLastSync < 58000) return;
  if (!fs.existsSync(GOOGLE_COOKIES)) {
    if (googleLastSync===0) console.warn('[Google] ⚠️  No google_cookies.txt — see README to export from Chrome');
    return;
  }

  let result;
  try { result = await runPython(GOOGLE_BRIDGE, [GOOGLE_EMAIL]); }
  catch(e) { console.error('[Google]', e.message); return; }

  if (!result.ok) {
    if (result.needs_install) { console.error('[Google] Run: py -m pip install locationsharinglib'); return; }
    if (result.needs_cookies) { console.warn('[Google]', result.error); return; }
    console.error('[Google]', result.error); return;
  }

  googleLastSync = Date.now();
  if (result.note) console.log('[Google]', result.note);

  const devices = db.getAllDevices();
  let   newCount = 0;

  (result.devices||[]).forEach((raw, i) => {
    const id   = `google-${raw.id||i}`;
    const name = raw.name || `Android Device ${i+1}`;
    const existing = devices.find(d=>d.id===id);
    const appleCount = devices.filter(d=>d.source==='apple').length;

    db.upsertDevice({
      id, name, source:'google',
      icon:          iconForName(name),
      color:         existing?.color || COLORS[(appleCount+i) % COLORS.length],
      status:        'active',
      battery_level: null,
      battery_status:null,
      model:         raw.model||null,
      last_seen:     new Date().toISOString(),
    });

    if (!existing) { console.log(`[Google] ✅ Found: "${name}"`); newCount++; }

    const loc = raw.location;
    if (!loc?.latitude) return;

    ingestLocation({
      id: uuidv4(), device_id: id,
      timestamp:    loc.timeStamp ? new Date(loc.timeStamp).toISOString() : new Date().toISOString(),
      lat:          loc.latitude,
      lng:          loc.longitude,
      accuracy:     loc.horizontalAccuracy||null,
      altitude:     null, speed:null,
      source:       'google',
      network_type: loc.locationType||'gps',
      address:      loc.address||null,
      is_old:       0,
    });
  });

  if (newCount) broadcast({ event:'devices_updated', devices:db.getAllDevices() });
  db.getAllDevices().filter(d=>d.source==='google').forEach(d=>{ try{analyzePatterns(d.id);}catch{} });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const devices   = db.getAllDevices();
  const locations = {};
  devices.forEach(d=>{ const l=db.getLatest(d.id); if(l) locations[d.id]=l; });

  ws.send(JSON.stringify({
    event:     'initial_state',
    devices,
    locations,
    alerts:    db.getAlerts(50),
    geofences: db.getGeofences(),
  }));

  ws.on('message', raw=>{
    try {
      const {action}=JSON.parse(raw);
      if(action==='sync_apple')  { appleLastSync=0;  syncApple(); }
      if(action==='sync_google') { googleLastSync=0; syncGoogle(); }
    }catch{}
  });
});

// ── REST API ──────────────────────────────────────────────────────────────────
// Devices
app.get('/api/devices',       (_,res)=>res.json(db.getAllDevices()));
app.get('/api/devices/:id',   (req,res)=>{
  const d=db.getAllDevices().find(d=>d.id===req.params.id);
  d?res.json(d):res.status(404).json({error:'Not found'});
});
app.get('/api/devices/:id/latest',  (req,res)=>res.json(db.getLatest(req.params.id)||null));
app.get('/api/devices/:id/history', (req,res)=>{
  const {from,to,limit=300}=req.query;
  res.json(from&&to?db.getHistoryRange(req.params.id,from,to,parseInt(limit)):db.getHistory(req.params.id,parseInt(limit)));
});
app.get('/api/devices/:id/patterns',(req,res)=>res.json(db.getPatterns(req.params.id)));

// Sync
app.post('/api/sync/apple',  async(_,res)=>{ appleLastSync=0;  await syncApple();  res.json(db.getAllDevices().filter(d=>d.source==='apple')); });
app.post('/api/sync/google', async(_,res)=>{ googleLastSync=0; await syncGoogle(); res.json(db.getAllDevices().filter(d=>d.source==='google')); });

// Apple 2FA
const twoFAAttempts = new Map(); // ip → { count, resetAt }
function check2FALimit(ip) {
  const now = Date.now();
  const entry = twoFAAttempts.get(ip) || { count: 0, resetAt: now + 300000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 300000; }
  entry.count++;
  twoFAAttempts.set(ip, entry);
  return entry.count <= 5;
}

app.get( '/api/apple/status', (_,res)=>res.json({ email:APPLE_EMAIL, pending2FA:applePending2FA, configured:!!APPLE_PASS, deviceCount:db.getAllDevices().filter(d=>d.source==='apple').length }));
app.post('/api/apple/2fa', async(req,res)=>{
  const ip = req.ip || req.connection.remoteAddress;
  if (!check2FALimit(ip)) return res.status(429).json({ error: 'Too many 2FA attempts — wait 5 minutes' });
  const { code } = req.body;
  if (!code || !/^\d{6}$/.test(String(code))) return res.status(400).json({ error: 'code must be a 6-digit number' });
  await syncApple(String(code));
  res.json({ ok: !applePending2FA, devices: db.getAllDevices() });
});

// Google
app.get('/api/google/status', (_,res)=>res.json({ email:GOOGLE_EMAIL, cookiesPresent:fs.existsSync(GOOGLE_COOKIES), deviceCount:db.getAllDevices().filter(d=>d.source==='google').length }));

// Alerts
app.get('/api/alerts',              (_,res)=>res.json(db.getAlerts(100)));
app.patch('/api/alerts/read-all',   (_,res)=>{ db.markAllAlertsRead(); res.json({ok:true}); });
app.patch('/api/alerts/:id/read',   (req,res)=>{ db.markAlertRead(req.params.id); res.json({ok:true}); });

// Geofences
app.get('/api/geofences',       (_,res)=>res.json(db.getGeofences()));
app.post('/api/geofences',      (req,res)=>{
  const{name,device_id,lat,lng,radius_m=100,notify_enter=1,notify_exit=1}=req.body;
  if(!name||lat==null||lng==null) return res.status(400).json({error:'name, lat, lng required'});
  const f={id:uuidv4(),name,device_id:device_id||null,lat:parseFloat(lat),lng:parseFloat(lng),radius_m:parseFloat(radius_m),notify_enter:notify_enter?1:0,notify_exit:notify_exit?1:0};
  db.insertGeofence(f);
  broadcast({event:'geofence_added',fence:f});
  res.json(f);
});
app.delete('/api/geofences/:id', (req,res)=>{ db.deleteGeofence(req.params.id); broadcast({event:'geofence_removed',id:req.params.id}); res.json({ok:true}); });

// Export
app.get('/api/export/:id', (req,res)=>{
  const{format='json',from,to}=req.query;
  const device  = db.getAllDevices().find(d=>d.id===req.params.id);
  const history = from&&to ? db.getHistoryRange(req.params.id,from,to,10000) : db.getHistory(req.params.id,10000);
  const fname   = (device?.name||req.params.id).replace(/[^a-z0-9]/gi,'_');
  if(format==='csv'){
    const rows=['timestamp,lat,lng,accuracy,altitude,speed,source,network_type,address',
      ...history.map(l=>`${l.timestamp},${l.lat},${l.lng},${l.accuracy||''},${l.altitude||''},${l.speed||''},${l.source},${l.network_type||''},${(l.address||'').replace(/,/g,' ')}`)
    ].join('\n');
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename="${fname}.csv"`);
    return res.send(rows);
  }
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition',`attachment; filename="${fname}.json"`);
  res.json({device,history,exportedAt:new Date().toISOString()});
});

// Stats
app.get('/api/stats', (_,res)=>res.json(db.getStats()));

// Health check
app.get('/api/health', (_,res)=>res.json({
  ok:true, uptime:Math.round(process.uptime()),
  db: db._usesSQLite?'sqlite':'json',
  apple:{ configured:!!APPLE_PASS, pending2FA:applePending2FA },
  google:{ cookiesPresent:fs.existsSync(GOOGLE_COOKIES) },
}));

// Fallback → serve index.html for all non-API routes (SPA)
app.get('*', (req,res)=>{
  if(req.path.startsWith('/api')) return res.status(404).json({error:'Not found'});
  res.sendFile(path.join(FRONTEND,'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.on('error', err=>{
  if(err.code==='EADDRINUSE'){
    console.error(`\n❌  Port ${PORT} in use.\n    Windows: netstat -ano | findstr :${PORT}  →  taskkill /PID <pid> /F\n`);
    process.exit(1);
  } else throw err;
});

server.listen(PORT, async()=>{
  const line = '═'.repeat(44);
  console.log(`\n╔${line}╗`);
  console.log(`║  NexTrack v2  —  http://localhost:${PORT}          ║`);
  console.log(`╠${line}╣`);
  console.log(`║  🍎  Apple : ${APPLE_EMAIL.padEnd(30)}║`);
  console.log(`║  🤖  Google: ${GOOGLE_EMAIL.padEnd(30)}║`);
  console.log(`║  🗺️   Maps  : ${(MAPS_KEY?'✓ configured':'⚠️  missing').padEnd(30)}║`);
  console.log(`║  🗄️   DB    : ${(db._usesSQLite?'SQLite (nextrack.db)':'JSON file store').padEnd(30)}║`);
  console.log(`╚${line}╝\n`);

  await syncApple();
  await syncGoogle();

  // Apple: 60s, Google: 60s, Patterns: every 5min, Prune: 3am daily
  cron.schedule('*/60 * * * * *', ()=>{ syncApple(); syncGoogle(); });
  cron.schedule('*/5 * * * *', ()=>{
    db.getAllDevices().forEach(d=>{ try{analyzePatterns(d.id);}catch{} });
  });
  cron.schedule('0 3 * * *', ()=>{
    db.getAllDevices().forEach(d=>db.pruneLocations(d.id));
    console.log('[DB] Pruned locations >30 days');
  });
});

module.exports = { app, server };
