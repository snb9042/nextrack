/**
 * db.js — Smart SQLite layer
 * Tries better-sqlite3 (fast, native) first.
 * Falls back to a JSON file store (pure JS, no compilation) if native build fails.
 * Both expose the exact same API so server.js never needs to change.
 */

const path = require('path');
const fs   = require('fs');

const DB_PATH   = path.join(__dirname, 'nextrack.db');
const JSON_PATH = path.join(__dirname, 'nextrack_data.json');

// ── Attempt native SQLite ─────────────────────────────────────────────────────
let useSQLite = false;
let sqliteDb  = null;

try {
  const Database = require('better-sqlite3');
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('synchronous = NORMAL');
  useSQLite = true;
  console.log('🗄️  Database: SQLite (better-sqlite3)');
} catch (e) {
  console.warn('⚠️  better-sqlite3 not available — using JSON file store');
  console.warn('   (Install Visual Studio Build Tools + run: npm rebuild better-sqlite3)');
  console.warn('   Data path:', JSON_PATH);
}

// ── JSON fallback store ───────────────────────────────────────────────────────
function loadJSON() {
  try { return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); }
  catch { return { devices:{}, locations:{}, alerts:[], geofences:[], patterns:{} }; }
}
function saveJSON(data) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
}

// ── Schema init ───────────────────────────────────────────────────────────────
function initSchema() {
  if (!useSQLite) return;
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'apple',
      icon TEXT DEFAULT '📍',
      color TEXT DEFAULT '#2997ff',
      status TEXT DEFAULT 'active',
      battery_level INTEGER,
      battery_status TEXT,
      model TEXT,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      altitude REAL,
      speed REAL,
      source TEXT,
      network_type TEXT,
      address TEXT,
      is_old INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_loc_device_time ON locations(device_id, timestamp DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      device_id TEXT,
      data TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS geofences (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      device_id TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      radius_m REAL NOT NULL DEFAULT 100,
      active INTEGER DEFAULT 1,
      notify_enter INTEGER DEFAULT 1,
      notify_exit INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      data TEXT,
      confidence REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

initSchema();

// ── Unified DB API ────────────────────────────────────────────────────────────
const db = {
  // ── Devices ────────────────────────────────────────────────────────────────
  upsertDevice(d) {
    if (useSQLite) {
      sqliteDb.prepare(`
        INSERT INTO devices (id,name,source,icon,color,status,battery_level,battery_status,model,last_seen)
        VALUES (@id,@name,@source,@icon,@color,@status,@battery_level,@battery_status,@model,@last_seen)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, status=excluded.status,
          battery_level=excluded.battery_level, battery_status=excluded.battery_status,
          last_seen=excluded.last_seen
      `).run(d);
    } else {
      const data = loadJSON();
      data.devices[d.id] = { ...(data.devices[d.id]||{}), ...d };
      saveJSON(data);
    }
  },

  getAllDevices() {
    if (useSQLite) {
      return sqliteDb.prepare(`SELECT * FROM devices ORDER BY last_seen DESC`).all();
    }
    return Object.values(loadJSON().devices).sort((a,b)=>
      new Date(b.last_seen||0)-new Date(a.last_seen||0));
  },

  // ── Locations ──────────────────────────────────────────────────────────────
  insertLocation(loc) {
    if (useSQLite) {
      sqliteDb.prepare(`
        INSERT OR IGNORE INTO locations
        (id,device_id,timestamp,lat,lng,accuracy,altitude,speed,source,network_type,address,is_old)
        VALUES (@id,@device_id,@timestamp,@lat,@lng,@accuracy,@altitude,@speed,@source,@network_type,@address,@is_old)
      `).run(loc);
    } else {
      const data = loadJSON();
      if (!data.locations[loc.device_id]) data.locations[loc.device_id] = [];
      // Avoid duplicates
      const hist = data.locations[loc.device_id];
      if (!hist.find(l=>l.id===loc.id)) {
        hist.push(loc);
        if (hist.length > 500) hist.shift();
      }
      saveJSON(data);
    }
  },

  getLatest(deviceId) {
    if (useSQLite) {
      return sqliteDb.prepare(`SELECT * FROM locations WHERE device_id=? ORDER BY timestamp DESC LIMIT 1`).get(deviceId);
    }
    const hist = loadJSON().locations[deviceId]||[];
    return hist[hist.length-1]||null;
  },

  getHistory(deviceId, limit=300) {
    if (useSQLite) {
      return sqliteDb.prepare(`SELECT * FROM locations WHERE device_id=? ORDER BY timestamp ASC LIMIT ?`).all(deviceId, limit);
    }
    const hist = loadJSON().locations[deviceId]||[];
    return hist.slice(-limit);
  },

  getHistoryRange(deviceId, from, to, limit=500) {
    if (useSQLite) {
      return sqliteDb.prepare(`SELECT * FROM locations WHERE device_id=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC LIMIT ?`).all(deviceId,from,to,limit);
    }
    const hist = loadJSON().locations[deviceId]||[];
    return hist.filter(l=>l.timestamp>=from&&l.timestamp<=to).slice(-limit);
  },

  pruneLocations(deviceId) {
    const cutoff = new Date(Date.now()-30*24*3600*1000).toISOString();
    if (useSQLite) {
      sqliteDb.prepare(`DELETE FROM locations WHERE device_id=? AND timestamp<?`).run(deviceId, cutoff);
    } else {
      const data = loadJSON();
      if (data.locations[deviceId]) {
        data.locations[deviceId] = data.locations[deviceId].filter(l=>l.timestamp>=cutoff);
        saveJSON(data);
      }
    }
  },

  // ── Alerts ─────────────────────────────────────────────────────────────────
  insertAlert(a) {
    if (useSQLite) {
      sqliteDb.prepare(`INSERT INTO alerts (id,type,device_id,data,created_at) VALUES (@id,@type,@device_id,@data,@created_at)`).run(a);
    } else {
      const data = loadJSON();
      data.alerts.unshift(a);
      if (data.alerts.length > 200) data.alerts.pop();
      saveJSON(data);
    }
  },

  getAlerts(limit=100) {
    if (useSQLite) {
      return sqliteDb.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`).all(limit)
        .map(a=>({...a, data:JSON.parse(a.data||'{}')}));
    }
    return loadJSON().alerts.slice(0,limit).map(a=>({...a, data:typeof a.data==='string'?JSON.parse(a.data||'{}'):a.data}));
  },

  markAlertRead(id) {
    if (useSQLite) { sqliteDb.prepare(`UPDATE alerts SET read=1 WHERE id=?`).run(id); }
    else { const data=loadJSON(); const a=data.alerts.find(a=>a.id===id); if(a)a.read=1; saveJSON(data); }
  },

  markAllAlertsRead() {
    if (useSQLite) { sqliteDb.prepare(`UPDATE alerts SET read=1`).run(); }
    else { const data=loadJSON(); data.alerts.forEach(a=>a.read=1); saveJSON(data); }
  },

  // ── Geofences ──────────────────────────────────────────────────────────────
  getGeofences() {
    if (useSQLite) return sqliteDb.prepare(`SELECT * FROM geofences WHERE active=1`).all();
    return loadJSON().geofences.filter(f=>f.active!==0);
  },

  getDeviceGeofences(deviceId) {
    if (useSQLite) return sqliteDb.prepare(`SELECT * FROM geofences WHERE active=1 AND (device_id=? OR device_id IS NULL)`).all(deviceId);
    return loadJSON().geofences.filter(f=>f.active!==0&&(!f.device_id||f.device_id===deviceId));
  },

  insertGeofence(f) {
    if (useSQLite) {
      sqliteDb.prepare(`INSERT INTO geofences (id,name,device_id,lat,lng,radius_m,notify_enter,notify_exit) VALUES (@id,@name,@device_id,@lat,@lng,@radius_m,@notify_enter,@notify_exit)`).run(f);
    } else {
      const data=loadJSON(); data.geofences.push({...f,active:1}); saveJSON(data);
    }
  },

  deleteGeofence(id) {
    if (useSQLite) { sqliteDb.prepare(`DELETE FROM geofences WHERE id=?`).run(id); }
    else { const data=loadJSON(); data.geofences=data.geofences.filter(f=>f.id!==id); saveJSON(data); }
  },

  // ── Patterns ───────────────────────────────────────────────────────────────
  upsertPattern(p) {
    if (useSQLite) {
      sqliteDb.prepare(`INSERT OR REPLACE INTO patterns (id,device_id,type,label,data,confidence,created_at) VALUES (@id,@device_id,@type,@label,@data,@confidence,@created_at)`).run(p);
    } else {
      const data=loadJSON();
      if (!data.patterns[p.device_id]) data.patterns[p.device_id]=[];
      const idx=data.patterns[p.device_id].findIndex(x=>x.id===p.id);
      if(idx>=0) data.patterns[p.device_id][idx]=p; else data.patterns[p.device_id].push(p);
      saveJSON(data);
    }
  },

  getPatterns(deviceId) {
    if (useSQLite) {
      return sqliteDb.prepare(`SELECT * FROM patterns WHERE device_id=? ORDER BY confidence DESC`).all(deviceId)
        .map(p=>({...p,data:JSON.parse(p.data||'{}')}));
    }
    return (loadJSON().patterns[deviceId]||[]).map(p=>({...p,data:typeof p.data==='string'?JSON.parse(p.data||'{}'):p.data}));
  },

  // ── Stats ──────────────────────────────────────────────────────────────────
  getStats() {
    const devices = this.getAllDevices();
    return devices.map(d => {
      const history = this.getHistory(d.id, 1000);
      let dist=0;
      for(let i=1;i<history.length;i++){
        const a=history[i-1],b=history[i];
        const R=6371000,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180;
        const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        dist+=R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
      }
      const avgAcc = history.length
        ? parseFloat((history.reduce((s,l)=>s+(l.accuracy||0),0)/history.length).toFixed(1)) : null;
      return {
        device: d,
        totalPoints: history.length,
        totalDistanceKm: parseFloat((dist/1000).toFixed(2)),
        firstSeen: history[0]?.timestamp||null,
        lastSeen: history[history.length-1]?.timestamp||null,
        avgAccuracy: avgAcc,
      };
    });
  },

  // Expose raw sqlite for advanced queries if needed
  get _sqlite() { return useSQLite ? sqliteDb : null; },
  get _usesSQLite() { return useSQLite; },
};

module.exports = db;
