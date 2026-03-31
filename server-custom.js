const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — loaded from config.json
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG_FILE = path.join(__dirname, 'config.json');

let USERS = {};

function loadConfig() {
  let data;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('FATAL: config.json not found at ' + CONFIG_FILE);
      process.exit(1);
    }
    console.error('FATAL: Failed to parse config.json — ' + err.message);
    process.exit(1);
  }

  // Validate users
  if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
    console.error('FATAL: config.json "users" must be an object with username:password pairs');
    process.exit(1);
  }
  if (Object.keys(data.users).length === 0) {
    console.error('FATAL: config.json has no users defined');
    process.exit(1);
  }

  // Validate domain
  if (!data.domain || typeof data.domain !== 'string') {
    console.error('FATAL: config.json "domain" is required');
    process.exit(1);
  }

  return data;
}

const configData = loadConfig();
USERS = configData.users;

const CONFIG = {
  PORT: configData.port || 443,
  HTTP_PORT: configData.http_port || 80,
  DOMAIN: configData.domain,
  AUDIO_DIRS: {
    MP3: configData.audio_dir_mp3 || '/var/spool/asterisk/monitorDone/MP3/',
    ROOT: configData.audio_dir_root || '/var/spool/asterisk/monitorDone/',
  },
  SSL_CERT: '/etc/letsencrypt/live/' + configData.domain + '/fullchain.pem',
  SSL_KEY: '/etc/letsencrypt/live/' + configData.domain + '/privkey.pem',
  SESSION_SECRET: crypto.randomBytes(64).toString('hex'),
  SESSION_MAX_AGE: (configData.session_ttl_minutes || 60) * 60 * 1000,
  CHUNK_SIZE: (configData.chunk_size_kb || 128) * 1024,
  ALLOWED_EXT: configData.allowed_extensions || ['.mp3', '.wav'],
  LOG_DIR: configData.log_dir || '/var/log/secure-audio-stream',
  LOG_RETENTION_DAYS: configData.log_retention_days || 30,
};

console.log('Config loaded: ' + Object.keys(USERS).length + ' user(s), domain=' + CONFIG.DOMAIN + ', port=' + CONFIG.PORT);

// Watch config.json for user changes (hot-reload users only, other changes need restart)
fs.watch(CONFIG_FILE, { persistent: false }, (eventType) => {
  if (eventType === 'change') {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.users && typeof data.users === 'object' && !Array.isArray(data.users) && Object.keys(data.users).length > 0) {
        USERS = data.users;
        console.log('Users hot-reloaded: ' + Object.keys(USERS).length + ' user(s)');
      }
    } catch (err) {
      console.warn('Config reload failed (keeping previous users): ' + err.message);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FILE LOGGER — writes daily rotating log files + mirrors to stdout
// ═══════════════════════════════════════════════════════════════════════════════
(function initLogger() {
  // Ensure log directory exists
  if (!fs.existsSync(CONFIG.LOG_DIR)) {
    fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
  }

  let currentDate = '';
  let logStream = null;

  function getLogDate() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function ensureStream() {
    const today = getLogDate();
    if (today !== currentDate || !logStream) {
      // Close previous stream
      if (logStream) {
        try { logStream.end(); } catch {}
      }
      currentDate = today;
      const logFile = path.join(CONFIG.LOG_DIR, `access-${today}.log`);
      logStream = fs.createWriteStream(logFile, { flags: 'a' }); // append mode
      logStream.on('error', (err) => {
        process.stderr.write('Log write error: ' + err.message + '\n');
      });
    }
    return logStream;
  }

  function writeToLog(level, args) {
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const line = `[${ts}] [${level}] ${msg}\n`;

    // Write to file
    try {
      ensureStream().write(line);
    } catch {}

    // Also write to original stdout/stderr
    if (level === 'ERROR') {
      originalStderr.call(process.stderr, line);
    } else {
      originalStdout.call(process.stdout, line);
    }
  }

  // Store original write methods
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  // Override console methods
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args) => writeToLog('INFO', args);
  console.error = (...args) => writeToLog('ERROR', args);
  console.warn = (...args) => writeToLog('WARN', args);

  // Clean up old log files on startup
  try {
    const cutoff = Date.now() - (CONFIG.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(CONFIG.LOG_DIR).filter(f => f.startsWith('access-') && f.endsWith('.log'));
    for (const file of files) {
      const filePath = path.join(CONFIG.LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}

  // Flush on exit
  process.on('exit', () => {
    if (logStream) try { logStream.end(); } catch {}
  });

  console.log('Logger initialized — writing to ' + CONFIG.LOG_DIR + '/access-' + getLogDate() + '.log');
})();

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════════════
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── Session middleware (shared between Express + WebSocket) ──
const sessionMiddleware = session({
  name: 'STREAM_SID',
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: CONFIG.SESSION_MAX_AGE,
  },
});
app.use(sessionMiddleware);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function logAccess(ip, username, filename, action) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]  IP=${ip}  USER=${username || 'anonymous'}  FILE=${filename}  ACTION=${action}`);
}

function xorCipher(buffer, username) {
  const key = crypto.createHash('sha256').update(username).digest();
  const output = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    output[i] = buffer[i] ^ key[i % key.length];
  }
  return output;
}

function sanitize(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function isAllowedFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONFIG.ALLOWED_EXT.includes(ext) && !filename.includes('..');
}

function resolveAudioPath(filename, baseDir) {
  const safe = path.basename(filename);
  const full = path.join(baseDir, safe);
  if (!full.startsWith(path.resolve(baseDir))) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASIC AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (req.session && req.session.username) return next();

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx !== -1) {
      const username = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      if (USERS[username] && USERS[username] === password) {
        req.session.username = username;
        req.session.loginAt = Date.now();
        logAccess(req.ip, username, req.path, 'LOGIN_SUCCESS');
        return next();
      }
    }
  }

  logAccess(req.ip, null, req.path, 'AUTH_REQUIRED');
  res.set('WWW-Authenticate', 'Basic realm="Secure Audio Server"');
  return res.status(401).send('Authentication required.');
}

app.use(requireAuth);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP ROUTES
//   /RECORDINGS/MP3/:filename  → plays from /var/spool/asterisk/monitorDone/MP3/
//   /RECORDINGS/:filename      → plays from /var/spool/asterisk/monitorDone/
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /RECORDINGS/MP3/:filename ──
app.get('/RECORDINGS/MP3/:filename', (req, res) => {
  const username = req.session.username;
  const filename = path.basename(req.params.filename);

  if (!isAllowedFile(filename)) return res.status(403).send('Forbidden file type.');

  const filePath = resolveAudioPath(filename, CONFIG.AUDIO_DIRS.MP3);
  if (!filePath) {
    logAccess(req.ip, username, 'MP3/' + filename, 'FILE_NOT_FOUND');
    return res.status(404).send('File not found.');
  }

  // logAccess(req.ip, username, 'MP3/' + filename, 'PLAYER_OPEN');
  res.set('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; media-src blob:; connect-src 'self' wss:"
  );
  res.type('html').send(getPlayerHTML(filename, username, 'MP3'));
});

// ── GET /RECORDINGS/:filename ──
app.get('/RECORDINGS/:filename', (req, res) => {
  const username = req.session.username;
  const filename = path.basename(req.params.filename);

  if (!isAllowedFile(filename)) return res.status(403).send('Forbidden file type.');

  const filePath = resolveAudioPath(filename, CONFIG.AUDIO_DIRS.ROOT);
  if (!filePath) {
    logAccess(req.ip, username, filename, 'FILE_NOT_FOUND');
    return res.status(404).send('File not found.');
  }

  // logAccess(req.ip, username, filename, 'PLAYER_OPEN');
  res.set('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; media-src blob:; connect-src 'self' wss:"
  );
  res.type('html').send(getPlayerHTML(filename, username, 'ROOT'));
});

// ── GET /download/MP3/:filename → direct file download ──
app.get('/download/MP3/:filename', (req, res) => {
  const username = req.session.username;
  const filename = path.basename(req.params.filename);

  if (!isAllowedFile(filename)) return res.status(403).send('Forbidden file type.');

  const filePath = resolveAudioPath(filename, CONFIG.AUDIO_DIRS.MP3);
  if (!filePath) {
    logAccess(req.ip, username, 'MP3/' + filename, 'DOWNLOAD_NOT_FOUND');
    return res.status(404).send('File not found.');
  }

  logAccess(req.ip, username, 'MP3/' + filename, 'DOWNLOAD');
  res.download(filePath, filename);
});

// ── GET /download/:filename → direct file download ──
app.get('/download/:filename', (req, res) => {
  const username = req.session.username;
  const filename = path.basename(req.params.filename);

  if (!isAllowedFile(filename)) return res.status(403).send('Forbidden file type.');

  const filePath = resolveAudioPath(filename, CONFIG.AUDIO_DIRS.ROOT);
  if (!filePath) {
    logAccess(req.ip, username, filename, 'DOWNLOAD_NOT_FOUND');
    return res.status(404).send('File not found.');
  }

  logAccess(req.ip, username, filename, 'DOWNLOAD');
  res.download(filePath, filename);
});

// Everything else → 404
app.use((req, res) => {
  res.status(404).send('Not found.');
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER — wss:///ws — handles encrypted audio chunk streaming
//
// Protocol:
//   Client sends TEXT:  { "action": "stream", "filename": "recording.mp3", "source": "MP3" }
//   Server sends TEXT:  { "type": "meta", "filename", "totalSize", "totalChunks", "chunkSize" }
//   Server sends BIN:   [128KB encrypted chunk #1]
//   Server sends BIN:   [128KB encrypted chunk #2]
//   ...
//   Server sends TEXT:  { "type": "done", "chunks": N }
//
//   Client can send TEXT:  { "action": "cancel" }  to abort mid-stream
// ═══════════════════════════════════════════════════════════════════════════════
function setupWebSocket(httpsServer) {
  const wss = new WebSocketServer({ noServer: true });

  // ── Upgrade handler: authenticate via shared session before upgrading ──
  httpsServer.on('upgrade', (req, socket, head) => {
    // Only handle /ws path
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }

    // Run session middleware to parse cookie
    const res = new http.ServerResponse(req);
    sessionMiddleware(req, res, () => {
      if (!req.session || !req.session.username) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        logAccess(req.socket.remoteAddress, null, '/ws', 'WS_AUTH_REJECTED');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.username = req.session.username;
        ws.clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.socket.remoteAddress || 'unknown';
        wss.emit('connection', ws, req);
      });
    });
  });

  // ── Connection handler ──
  wss.on('connection', (ws) => {
    const username = ws.username;
    const ip = ws.clientIP;
    let activeStream = null;  // track active file read stream for cancellation

    // logAccess(ip, username, '/ws', 'WS_CONNECTED');

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // ── Cancel current stream ──
      if (msg.action === 'cancel') {
        if (activeStream) {
          activeStream.destroy();
          activeStream = null;
          // logAccess(ip, username, msg.filename || '?', 'WS_STREAM_CANCELLED');
        }
        return;
      }

      // ── Stream a file ──
      if (msg.action === 'stream') {
        const filename = path.basename(msg.filename || '');
        const source = msg.source || 'ROOT';

        // Resolve base directory from source
        const baseDir = CONFIG.AUDIO_DIRS[source];
        if (!baseDir) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid source' }));
          return;
        }

        if (!isAllowedFile(filename)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Forbidden file type' }));
          return;
        }

        const filePath = resolveAudioPath(filename, baseDir);
        if (!filePath) {
          ws.send(JSON.stringify({ type: 'error', message: 'File not found' }));
          logAccess(ip, username, (source === 'MP3' ? 'MP3/' : '') + filename, 'WS_FILE_NOT_FOUND');
          return;
        }

        // Cancel any existing stream first
        if (activeStream) {
          activeStream.destroy();
          activeStream = null;
        }

        const stat = fs.statSync(filePath);
        const totalChunks = Math.ceil(stat.size / CONFIG.CHUNK_SIZE);

        logAccess(ip, username, filename, `WS_STREAM_START (${totalChunks} chunks, ${(stat.size / 1024).toFixed(0)} KB)`);

        // Send metadata first
        ws.send(JSON.stringify({
          type: 'meta',
          filename,
          totalSize: stat.size,
          totalChunks,
          chunkSize: CONFIG.CHUNK_SIZE,
        }));

        // Stream encrypted chunks as binary frames
        const readStream = fs.createReadStream(filePath, { highWaterMark: CONFIG.CHUNK_SIZE });
        activeStream = readStream;
        let chunkIndex = 0;

        readStream.on('data', (chunk) => {
          if (ws.readyState !== 1) { // not OPEN
            readStream.destroy();
            return;
          }

          chunkIndex++;
          const encrypted = xorCipher(chunk, username);

          // logAccess(ip, username, filename, `WS_CHUNK ${chunkIndex}/${totalChunks} (${chunk.length} bytes)`);

          // Send as binary frame with backpressure
          const canContinue = ws.send(encrypted, { binary: true }, (err) => {
            if (err) {
              readStream.destroy();
              logAccess(ip, username, filename, 'WS_SEND_ERROR: ' + err.message);
            }
          });

          // Backpressure: pause if buffered amount is high
          if (ws.bufferedAmount > CONFIG.CHUNK_SIZE * 4) {
            readStream.pause();
            const checkDrain = setInterval(() => {
              if (ws.bufferedAmount < CONFIG.CHUNK_SIZE * 2) {
                clearInterval(checkDrain);
                readStream.resume();
              }
            }, 50);
          }
        });

        readStream.on('end', () => {
          activeStream = null;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'done', chunks: chunkIndex }));
          }
          // logAccess(ip, username, filename, `WS_STREAM_COMPLETE (${chunkIndex} chunks)`);
        });

        readStream.on('error', (err) => {
          activeStream = null;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Read error: ' + err.message }));
          }
          logAccess(ip, username, filename, 'WS_STREAM_ERROR: ' + err.message);
        });

        return;
      }

      ws.send(JSON.stringify({ type: 'error', message: 'Unknown action: ' + msg.action }));
    });

    ws.on('close', () => {
      if (activeStream) {
        activeStream.destroy();
        activeStream = null;
      }
      // logAccess(ip, username, '/ws', 'WS_DISCONNECTED');
    });

    ws.on('error', (err) => {
      logAccess(ip, username, '/ws', 'WS_ERROR: ' + err.message);
    });
  });

  return wss;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTML TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

function getPlayerHTML(filename, username, source) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${sanitize(filename)} — Secure Player</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Outfit:wght@300;500;700&display=swap');

  :root {
    --bg: #0c0e13;
    --surface: #161921;
    --surface-2: #1e222d;
    --border: #2a2f3d;
    --accent: #22d3ee;
    --accent-dim: rgba(34, 211, 238, 0.12);
    --text: #e4e8f1;
    --dim: #6b7394;
    --danger: #f43f5e;
    --green: #22c55e;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg); color: var(--text); font-family: 'Outfit', sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    user-select: none; -webkit-user-select: none;
  }
  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none;
    background:
      radial-gradient(ellipse 600px 400px at 20% 30%, rgba(34,211,238,0.06) 0%, transparent 70%),
      radial-gradient(ellipse 500px 350px at 80% 70%, rgba(99,102,241,0.05) 0%, transparent 70%);
  }

  .card {
    position: relative; background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 40px; width: 500px; max-width: 94vw;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
  }

  .filename { font-size: 18px; font-weight: 700; word-break: break-all; margin-bottom: 28px; text-align: center; }

  .wave { height: 56px; display: flex; align-items: center; justify-content: center; gap: 3px; margin-bottom: 24px; }
  .wave-bar { width: 4px; background: var(--accent); border-radius: 4px; opacity: 0.25; height: 8px;
    transition: height 0.08s ease, opacity 0.08s ease; }

  /* Progress bar — scrub-able */
  .progress-track {
    width: 100%; height: 6px; background: var(--surface-2); border-radius: 3px;
    cursor: pointer; margin-bottom: 12px; position: relative; transition: height 0.15s ease;
  }
  .progress-track:hover { height: 10px; }
  .progress-track:hover .progress-thumb { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 3px; width: 0%; pointer-events: none; }
  .progress-thumb {
    position: absolute; top: 50%; width: 16px; height: 16px;
    background: var(--accent); border: 2px solid var(--bg); border-radius: 50%; pointer-events: none;
    transform: translate(-50%, -50%) scale(0); opacity: 0; transition: opacity 0.15s, transform 0.15s;
    box-shadow: 0 0 8px rgba(34,211,238,0.4);
  }
  .progress-track.dragging { height: 10px; }
  .progress-track.dragging .progress-thumb { opacity: 1; transform: translate(-50%, -50%) scale(1); }

  .time-row { display: flex; justify-content: space-between; font-family: 'JetBrains Mono', monospace;
    font-size: 12px; color: var(--dim); margin-bottom: 28px; }

  .controls { display: flex; align-items: center; justify-content: center; gap: 20px; }
  .btn { background: none; border: none; color: var(--dim); cursor: pointer; display: flex;
    align-items: center; justify-content: center; transition: color 0.2s, transform 0.15s; }
  .btn:hover { color: var(--text); transform: scale(1.1); }
  .btn svg { width: 28px; height: 28px; }
  .btn-play { width: 60px; height: 60px; background: var(--accent); border-radius: 50%; color: var(--bg); }
  .btn-play:hover { background: #06b6d4; color: var(--bg); transform: scale(1.08); }
  .btn-play svg { width: 26px; height: 26px; }

  .status { text-align: center; font-size: 12px; color: var(--dim); font-family: 'JetBrains Mono', monospace;
    margin-top: 20px; min-height: 16px; }
  .status.error { color: var(--danger); }
  .status.ok { color: var(--green); }

  .volume-row { display: flex; align-items: center; gap: 10px; margin-top: 20px; justify-content: center; }
  .volume-row svg { width: 18px; height: 18px; color: var(--dim); flex-shrink: 0; }
  .vol-slider { -webkit-appearance: none; appearance: none; width: 120px; height: 4px; border-radius: 2px;
    background: var(--surface-2); outline: none; cursor: pointer; }
  .vol-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
    background: var(--accent); cursor: pointer; }
  .vol-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%;
    background: var(--accent); cursor: pointer; border: none; }

  .speed-row { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; }
  .speed-btn {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--dim); font-family: 'JetBrains Mono', monospace; font-size: 11px;
    padding: 4px 10px; cursor: pointer; transition: all 0.15s;
  }
  .speed-btn:hover { color: var(--text); border-color: var(--text); }
  .speed-btn.active { color: var(--accent); border-color: var(--accent); background: rgba(34,211,238,0.08); }

  .btn-download {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin: 20px auto 0; padding: 10px 24px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
    color: var(--dim); font-family: 'JetBrains Mono', monospace; font-size: 12px;
    cursor: pointer; text-decoration: none; transition: all 0.2s;
  }
  .btn-download:hover { color: var(--accent); border-color: var(--accent); background: rgba(34,211,238,0.06); }
  .btn-download svg { width: 16px; height: 16px; }


</style>
</head>
<body oncontextmenu="return false">
<div class="card">
  <div class="filename">${sanitize(filename)}</div>

  <div class="wave" id="wave">
    ${Array.from({ length: 40 }, () => '<div class="wave-bar"></div>').join('')}
  </div>

  <div class="progress-track" id="progressTrack">
    <div class="progress-fill" id="progressFill"></div>
    <div class="progress-thumb" id="progressThumb"></div>
  </div>

  <div class="time-row">
    <span id="timeCur">0:00</span>
    <span id="timeDur">--:--</span>
  </div>

  <div class="controls">
    <button class="btn" id="btnRew" title="Rewind 10s">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
        <text x="12" y="16" fill="currentColor" stroke="none" font-size="7" text-anchor="middle" font-family="sans-serif">10</text>
      </svg>
    </button>
    <button class="btn btn-play" id="btnPlay" title="Play / Pause">
      <svg id="iconPlay" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
      <svg id="iconPause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>
    </button>
    <button class="btn" id="btnFwd" title="Forward 10s">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/>
        <text x="12" y="16" fill="currentColor" stroke="none" font-size="7" text-anchor="middle" font-family="sans-serif">10</text>
      </svg>
    </button>
  </div>

  <div class="volume-row">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    </svg>
    <input type="range" class="vol-slider" id="volSlider" min="0" max="1" step="0.01" value="1">
  </div>

  <div class="speed-row">
    <button class="speed-btn" data-speed="0.5">0.5x</button>
    <button class="speed-btn" data-speed="0.75">0.75x</button>
    <button class="speed-btn active" data-speed="1">1x</button>
    <button class="speed-btn" data-speed="1.25">1.25x</button>
    <button class="speed-btn" data-speed="1.5">1.5x</button>
    <button class="speed-btn" data-speed="2">2x</button>
  </div>

  <div class="status" id="status">Click play to start</div>

  <a class="btn-download" href="/download/${source === 'MP3' ? 'MP3/' : ''}${encodeURIComponent(filename)}" download="${sanitize(filename)}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Download
  </a>
</div>

<script>
(function() {
  // ── Anti-download ──
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['s','S','u','U','p','P'].includes(e.key)) e.preventDefault();
    if (e.key === 'F12') e.preventDefault();
  });

  const USERNAME   = ${JSON.stringify(username)};
  const FILENAME   = ${JSON.stringify(filename)};
  const SOURCE     = ${JSON.stringify(source)};

  // DOM
  const btnPlay       = document.getElementById('btnPlay');
  const iconPlay      = document.getElementById('iconPlay');
  const iconPause     = document.getElementById('iconPause');
  const btnRew        = document.getElementById('btnRew');
  const btnFwd        = document.getElementById('btnFwd');
  const progressTrack = document.getElementById('progressTrack');
  const progressFill  = document.getElementById('progressFill');
  const progressThumb = document.getElementById('progressThumb');
  const timeCur       = document.getElementById('timeCur');
  const timeDur       = document.getElementById('timeDur');
  const statusEl      = document.getElementById('status');
  const waveBars      = document.querySelectorAll('.wave-bar');
  const volSlider     = document.getElementById('volSlider');
  const speedBtns     = document.querySelectorAll('.speed-btn');

  let audioCtx    = null;
  let gainNode    = null;
  let analyser    = null;
  let dataArray   = null;
  let audioEl     = null;   // hidden <audio> element (preservesPitch)
  let mediaSource = null;   // MediaElementSourceNode
  let audioBlobUrl = null;
  let audioDuration = 0;
  let isPlaying   = false;
  let isLoading   = false;
  let animFrame   = null;
  let loaded      = false;
  let playbackRate = 1;

  // ── XOR decrypt (mirrors server-side SHA256 key derivation) ──
  async function deriveKey(username) {
    const enc = new TextEncoder().encode(username);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return new Uint8Array(hash);
  }

  function xorDecrypt(data, key) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = data[i] ^ key[i % key.length];
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WebSocket streaming
  // ══════════════════════════════════════════════════════════════════════════
  async function loadAudio() {
    if (isLoading) return false;  // prevent duplicate loads
    isLoading = true;
    btnPlay.disabled = true;
    btnPlay.style.opacity = '0.5';
    statusEl.textContent = 'Connecting…';
    statusEl.className = 'status';

    const xorKey = await deriveKey(USERNAME);

    return new Promise((resolve) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = protocol + '://' + location.host + '/ws';
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      let totalSize = 0;
      let chunkCount = 0;
      let receivedBytes = 0;
      const encryptedChunks = [];
      let t0 = 0;

      ws.onopen = () => {
        statusEl.textContent = 'Loading…';
        t0 = performance.now();
        ws.send(JSON.stringify({ action: 'stream', filename: FILENAME, source: SOURCE }));
      };

      ws.onmessage = (event) => {
        // Binary frame = encrypted audio chunk
        if (event.data instanceof ArrayBuffer) {
          chunkCount++;
          receivedBytes += event.data.byteLength;
          encryptedChunks.push(new Uint8Array(event.data));

          const pct = totalSize > 0 ? Math.round(receivedBytes / totalSize * 100) : 0;
          statusEl.textContent = 'Loading… ' + pct + '%';
          return;
        }

        // Text frame = JSON control message
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'meta') {
          totalSize = msg.totalSize;
          statusEl.textContent = 'Loading…';
        }

        if (msg.type === 'done') {
          ws.close();
          decryptAndDecode(encryptedChunks, xorKey, receivedBytes, chunkCount, t0).then(resolve);
        }

        if (msg.type === 'error') {
          statusEl.textContent = 'Error: ' + msg.message;
          statusEl.className = 'status error';
          ws.close();
          isLoading = false; btnPlay.disabled = false; btnPlay.style.opacity = '';
          resolve(false);
        }
      };

      ws.onerror = () => {
        statusEl.textContent = 'Connection failed';
        statusEl.className = 'status error';
        isLoading = false; btnPlay.disabled = false; btnPlay.style.opacity = '';
        resolve(false);
      };

      ws.onclose = (e) => {
        if (!loaded && chunkCount > 0 && encryptedChunks.length === chunkCount) {
          decryptAndDecode(encryptedChunks, xorKey, receivedBytes, chunkCount, t0).then(resolve);
        } else if (!loaded) {
          // Connection closed without completing
          isLoading = false; btnPlay.disabled = false; btnPlay.style.opacity = '';
        }
      };
    });
  }

  async function decryptAndDecode(encryptedChunks, xorKey, receivedBytes, chunkCount, t0) {
    try {
      statusEl.textContent = 'All chunks received. Decrypting…';

      // Combine
      const encrypted = new Uint8Array(receivedBytes);
      let off = 0;
      for (const c of encryptedChunks) { encrypted.set(c, off); off += c.length; }

      // Decrypt
      const decrypted = xorDecrypt(encrypted, xorKey);

      // Create a blob URL and load into a hidden <audio> element
      // This gives us preservesPitch for free (pitch stays constant when speed changes)
      statusEl.textContent = 'Decoding audio…';
      const blob = new Blob([decrypted.buffer], { type: 'audio/mpeg' });
      audioBlobUrl = URL.createObjectURL(blob);

      audioEl = new Audio();
      audioEl.src = audioBlobUrl;
      audioEl.preload = 'auto';
      audioEl.playbackRate = playbackRate;

      await new Promise((res, rej) => {
        audioEl.addEventListener('canplaythrough', res, { once: true });
        audioEl.addEventListener('error', () => rej(new Error('Audio decode failed')), { once: true });
        audioEl.load();
      });

      // Connect to Web Audio API for visualizer
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        gainNode = audioCtx.createGain();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        gainNode.connect(analyser);
        analyser.connect(audioCtx.destination);
      }

      mediaSource = audioCtx.createMediaElementSource(audioEl);
      mediaSource.connect(gainNode);

      audioDuration = audioEl.duration;
      timeDur.textContent = fmtTime(audioDuration);

      audioEl.addEventListener('ended', () => { if (isPlaying) stop(); });

      const totalMs = (performance.now() - t0).toFixed(0);
      statusEl.textContent = 'Ready';
      statusEl.className = 'status ok';
      loaded = true;
      isLoading = false; btnPlay.disabled = false; btnPlay.style.opacity = '';
      return true;
    } catch (err) {
      statusEl.textContent = 'Decode error: ' + err.message;
      statusEl.className = 'status error';
      console.error(err);
      isLoading = false; btnPlay.disabled = false; btnPlay.style.opacity = '';
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Playback controls — uses hidden <audio> element for pitch-preserved speed
  // ══════════════════════════════════════════════════════════════════════════
  function play() {
    if (!audioEl || !audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    audioEl.playbackRate = playbackRate;
    audioEl.play();
    isPlaying = true;
    iconPlay.style.display = 'none';
    iconPause.style.display = '';
    statusEl.textContent = 'Playing';
    statusEl.className = 'status ok';
    animate();
  }

  function pause() {
    if (!isPlaying) return;
    audioEl.pause();
    isPlaying = false;
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    statusEl.textContent = 'Paused';
    statusEl.className = 'status';
    cancelAnimationFrame(animFrame);
    resetBars();
  }

  function stop() {
    if (audioEl && isPlaying) {
      audioEl.pause();
      audioEl.currentTime = 0;
    }
    isPlaying = false;
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    progressFill.style.width = '0%';
    progressThumb.style.left = '0%';
    timeCur.textContent = '0:00';
    statusEl.textContent = 'Ready';
    statusEl.className = 'status ok';
    cancelAnimationFrame(animFrame);
    resetBars();
  }

  function seekTo(frac) {
    if (!audioEl || !audioDuration) return;
    frac = Math.max(0, Math.min(1, frac));
    audioEl.currentTime = frac * audioDuration;
    if (!isPlaying) {
      timeCur.textContent = fmtTime(audioEl.currentTime);
      progressFill.style.width = (frac * 100) + '%';
      progressThumb.style.left = (frac * 100) + '%';
    }
  }

  // ── Visualizer ──
  function animate() {
    if (!isPlaying) return;
    animFrame = requestAnimationFrame(animate);
    if (!isDragging) {
      const cur = audioEl.currentTime;
      const pct = Math.min(cur / audioDuration * 100, 100);
      progressFill.style.width = pct + '%';
      progressThumb.style.left = pct + '%';
      timeCur.textContent = fmtTime(cur);
    }
    analyser.getByteFrequencyData(dataArray);
    const step = Math.max(1, Math.floor(dataArray.length / waveBars.length));
    for (let i = 0; i < waveBars.length; i++) {
      const val = dataArray[i * step] || 0;
      waveBars[i].style.height = (4 + (val / 255) * 48) + 'px';
      waveBars[i].style.opacity = (0.3 + (val / 255) * 0.7).toFixed(2);
    }
  }

  function resetBars() { waveBars.forEach(b => { b.style.height = '8px'; b.style.opacity = '0.25'; }); }

  function fmtTime(s) {
    if (!isFinite(s)) return '0:00';
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }

  // ── Events ──
  btnPlay.addEventListener('click', async () => {
    if (isLoading) return;  // already loading, ignore
    if (!loaded) {
      const ok = await loadAudio();
      if (ok) play();
      return;
    }
    isPlaying ? pause() : play();
  });

  btnRew.addEventListener('click', () => {
    if (!audioEl) return;
    seekTo(Math.max(0, audioEl.currentTime - 10) / audioDuration);
  });

  btnFwd.addEventListener('click', () => {
    if (!audioEl) return;
    seekTo(Math.min(audioDuration, audioEl.currentTime + 10) / audioDuration);
  });

  // ── Progress bar: drag + touch scrubbing ──
  let isDragging = false;
  let lastDragFrac = 0;
  let wasPlayingBeforeDrag = false;

  function scrubFromEvent(e) {
    const rect = progressTrack.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    lastDragFrac = frac;
    progressFill.style.transition = 'none';
    progressFill.style.width = (frac * 100) + '%';
    progressThumb.style.left = (frac * 100) + '%';
    if (audioDuration) timeCur.textContent = fmtTime(frac * audioDuration);
    return frac;
  }

  function startDrag(e) {
    if (!audioEl) return;
    e.preventDefault();
    isDragging = true;
    wasPlayingBeforeDrag = isPlaying;
    progressTrack.classList.add('dragging');
    if (isPlaying) {
      audioEl.pause();
      isPlaying = false;
      cancelAnimationFrame(animFrame);
    }
    scrubFromEvent(e);
  }

  function moveDrag(e) {
    if (!isDragging) return;
    e.preventDefault();
    scrubFromEvent(e);
  }

  function endDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    progressTrack.classList.remove('dragging');
    progressFill.style.transition = 'width 0.12s linear';
    audioEl.currentTime = lastDragFrac * audioDuration;
    if (wasPlayingBeforeDrag) {
      play();
    } else {
      timeCur.textContent = fmtTime(audioEl.currentTime);
      progressFill.style.width = (lastDragFrac * 100) + '%';
      progressThumb.style.left = (lastDragFrac * 100) + '%';
    }
  }

  progressTrack.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', moveDrag);
  document.addEventListener('mouseup', endDrag);
  progressTrack.addEventListener('touchstart', startDrag, { passive: false });
  document.addEventListener('touchmove', moveDrag, { passive: false });
  document.addEventListener('touchend', endDrag);

  volSlider.addEventListener('input', () => {
    if (gainNode) gainNode.gain.value = parseFloat(volSlider.value);
  });

  // ── Playback speed buttons ──
  speedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const newRate = parseFloat(btn.dataset.speed);
      playbackRate = newRate;

      // Update active state
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Apply immediately — <audio> element preserves pitch by default
      if (audioEl) {
        audioEl.playbackRate = newRate;
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && loaded) { e.preventDefault(); isPlaying ? pause() : play(); }
    if (e.code === 'ArrowLeft') btnRew.click();
    if (e.code === 'ArrowRight') btnFwd.click();
  });
})();
</script>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRASH HANDLERS — log before exit so the log file captures the reason
// ═══════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — crashing:', err.stack || err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION — crashing:', reason?.stack || reason);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVERS
// ═══════════════════════════════════════════════════════════════════════════════
try {
  const sslOptions = {
    cert: fs.readFileSync(CONFIG.SSL_CERT),
    key: fs.readFileSync(CONFIG.SSL_KEY),
  };

  const server = https.createServer(sslOptions, app);

  // Attach WebSocket server to the same HTTPS server
  setupWebSocket(server);

  server.listen(CONFIG.PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║   Secure Audio Stream Server — Running        ║');
    console.log('  ╠═══════════════════════════════════════════════╣');
    console.log(`  ║  HTTPS     : https://0.0.0.0:${CONFIG.PORT}                ║`);
    console.log(`  ║  WebSocket : wss://0.0.0.0:${CONFIG.PORT}/ws              ║`);
    console.log(`  ║  Audio MP3 : ${CONFIG.AUDIO_DIRS.MP3}`);
    console.log(`  ║  Audio ROOT: ${CONFIG.AUDIO_DIRS.ROOT}`);
    console.log(`  ║  Chunk size: ${CONFIG.CHUNK_SIZE / 1024} KB                           ║`);
    console.log(`  ║  Session   : ${CONFIG.SESSION_MAX_AGE / 60000} min TTL                       ║`);
    console.log(`  ║  Log dir   : ${CONFIG.LOG_DIR}`);
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log('');
  });

  // HTTP → HTTPS redirect
  const httpApp = express();
  httpApp.all('*', (req, res) => {
    const host = req.headers.host?.replace(/:.*/, '') || 'localhost';
    res.redirect(301, `https://${host}${req.url}`);
  });
  http.createServer(httpApp).listen(CONFIG.HTTP_PORT, () => {
    console.log(`  HTTP→HTTPS redirect on :${CONFIG.HTTP_PORT}`);
  });

} catch (err) {
  if (err.code === 'ENOENT' && err.path?.includes('letsencrypt')) {
    console.error('SSL certificate not found.');
    console.error('  Update CONFIG.SSL_CERT and CONFIG.SSL_KEY in server.js');
    console.error('  Expected: ' + CONFIG.SSL_CERT);
  } else {
    console.error('Failed to start: ' + err.message);
  }
  process.exit(1);
}
