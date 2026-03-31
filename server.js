const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

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

// ── Session middleware ──
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
//   /RECORDINGS/MP3/:filename  → streams audio from MP3 dir
//   /RECORDINGS/:filename      → streams audio from ROOT dir
// ═══════════════════════════════════════════════════════════════════════════════

// ── Audio streaming helper (supports Range requests for seeking) ──
function streamAudio(req, res, filename, baseDir, sourceLabel) {
  const username = req.session.username;

  if (!isAllowedFile(filename)) return res.status(403).send('Forbidden file type.');

  const filePath = resolveAudioPath(filename, baseDir);
  if (!filePath) {
    logAccess(req.ip, username, sourceLabel + filename, 'AUDIO_NOT_FOUND');
    return res.status(404).send('File not found.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    // Log on initial range request (start=0 means the audio element just loaded/played this file)
    if (start === 0) {
      logAccess(req.ip, username, sourceLabel + filename, `AUDIO_STREAM (${(fileSize / 1024).toFixed(0)} KB)`);
    }

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });

    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });

    stream.pipe(res);
  } else {
    // Full file request (no Range header)
    logAccess(req.ip, username, sourceLabel + filename, `AUDIO_STREAM (${(fileSize / 1024).toFixed(0)} KB)`);

    res.set({
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });

    fs.createReadStream(filePath).pipe(res);
  }
}

// ── Audio stream endpoints ──
app.get('/RECORDINGS/MP3/:filename', (req, res) => {
  streamAudio(req, res, path.basename(req.params.filename), CONFIG.AUDIO_DIRS.MP3, 'MP3/');
});

app.get('/RECORDINGS/:filename', (req, res) => {
  streamAudio(req, res, path.basename(req.params.filename), CONFIG.AUDIO_DIRS.ROOT, '');
});

// Everything else → 404
app.use((req, res) => {
  res.status(404).send('Not found.');
});

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

  server.listen(CONFIG.PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║   Audio Stream Server — Running                ║');
    console.log('  ╠═══════════════════════════════════════════════╣');
    console.log(`  ║  HTTPS     : https://0.0.0.0:${CONFIG.PORT}                ║`);
    console.log(`  ║  Audio MP3 : ${CONFIG.AUDIO_DIRS.MP3}`);
    console.log(`  ║  Audio ROOT: ${CONFIG.AUDIO_DIRS.ROOT}`);
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
