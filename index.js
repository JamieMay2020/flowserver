import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { TransferEngine } from "./solana/transferLoop.js";
import sqlite3 from "sqlite3";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const engine = new TransferEngine(process.env);

// (CAPTCHA removed)

// ------------------------------
// 🔹 Start streaming payments
// ------------------------------
app.post("/start", async (req, res) => {
  const { userPubkey, uploaderPubkey } = req.body || {};
  if (!userPubkey) return res.status(400).json({ error: "Missing userPubkey" });

  try {
    engine.start(userPubkey, uploaderPubkey);

    // Respond immediately while backend begins streaming
    return res.json({ ok: true, status: "starting" });
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
});

// ------------------------------
// 🔹 Stop streaming
// ------------------------------
app.post("/stop", (_req, res) => {
  engine.firstTransferConfirmed = false; // reset flag
  engine.stop();
  return res.json({ ok: true });
});

// ------------------------------a
// 🔹 Return logs (frontend polling)
// ------------------------------
app.get("/logs", (_req, res) => {
  return res.json(engine.getLogs());
});

// ------------------------------
// 🔹 NEW: Return status
// ------------------------------
app.get("/status", (_req, res) => {
  return res.json(engine.getStatus());
});

// ------------------------------
// 🔹 SQLite setup for video catalog
// ------------------------------
const dbPath = process.env.DB_PATH || "/data/videos.sqlite";
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownerPublicKey TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      videoUrl TEXT NOT NULL,
      thumbnailUrl TEXT NOT NULL,
      lamportsPerSecond INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      status TEXT NOT NULL
    )`
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos(ownerPublicKey)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(createdAt)`);
});

// ------------------------------
// 🔹 Helpers: URL allowlist & admin gate & rate limits
// ------------------------------
const ALLOWED_VIDEO_HOSTS = [
  "youtube.com",
  "vimeo.com",
  "ipfs.io",
  "cloudflarestream.com"
];

function isAllowedHost(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return ALLOWED_VIDEO_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function requireAdmin(req, res) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY) return res.status(500).json({ error: "ADMIN_KEY not configured" });
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  return null;
}

async function getPendingCount(ownerPublicKey) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as c FROM videos WHERE ownerPublicKey = ? AND status = 'pending'`,
      [ownerPublicKey],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.c || 0);
      }
    );
  });
}

async function getLastCreatedAt(ownerPublicKey) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT createdAt FROM videos WHERE ownerPublicKey = ? ORDER BY createdAt DESC LIMIT 1`,
      [ownerPublicKey],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.createdAt || 0);
      }
    );
  });
}

// ------------------------------
// 🔹 Video submission (requires CAPTCHA)
// ------------------------------
app.post("/videos", async (req, res) => {
  const { ownerPublicKey, title, description, videoUrl, thumbnailUrl, lamportsPerSecond } = req.body || {};

  if (!ownerPublicKey || !title || !videoUrl || !thumbnailUrl || typeof lamportsPerSecond === "undefined") {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // URL allowlist
  if (!isAllowedHost(videoUrl)) return res.status(400).json({ error: "Video URL host not allowed" });
  if (!/^https?:\/\//i.test(thumbnailUrl)) return res.status(400).json({ error: "Invalid thumbnail URL" });

  const rate = Number(lamportsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: "Invalid lamportsPerSecond" });

  try {
    // Limits
    const pending = await getPendingCount(ownerPublicKey);
    if (pending >= 3) return res.status(429).json({ error: "Too many pending submissions" });
    const last = await getLastCreatedAt(ownerPublicKey);
    if (Date.now() - last < 2 * 60 * 1000) return res.status(429).json({ error: "Please wait before submitting again" });

    const now = Date.now();
    db.run(
      `INSERT INTO videos (ownerPublicKey, title, description, videoUrl, thumbnailUrl, lamportsPerSecond, createdAt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [ownerPublicKey, String(title).slice(0, 200), String(description || '').slice(0, 2000), videoUrl, thumbnailUrl, rate, now],
      function(err) {
        if (err) return res.status(500).json({ error: "DB error" });
        return res.json({ ok: true, id: this.lastID });
      }
    );
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

// ------------------------------
// 🔹 List approved videos (public)
// ------------------------------
app.get("/videos", (_req, res) => {
  db.all(`SELECT * FROM videos WHERE status = 'approved' ORDER BY createdAt DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    return res.json(rows || []);
  });
});

// ------------------------------
// 🔹 List pending videos (admin)
// ------------------------------
app.get("/videos/pending", (req, res) => {
  if (requireAdmin(req, res) !== null) return; // early exit on unauthorized
  db.all(`SELECT * FROM videos WHERE status = 'pending' ORDER BY createdAt ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    return res.json(rows || []);
  });
});

// ------------------------------
// 🔹 Approve / Reject (admin)
// ------------------------------
app.post("/videos/:id/approve", (req, res) => {
  if (requireAdmin(req, res) !== null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  db.run(`UPDATE videos SET status = 'approved' WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true });
  });
});

app.post("/videos/:id/reject", (req, res) => {
  if (requireAdmin(req, res) !== null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  db.run(`UPDATE videos SET status = 'rejected' WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true });
  });
});

// ------------------------------
// 🔹 Wallet-signed moderation (admin = CREATOR_WALLET)
// ------------------------------
const nonces = new Map();

app.get("/admin/nonce", (_req, res) => {
  const nonce = Math.random().toString(36).slice(2) + Date.now();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  nonces.set(nonce, expiresAt);
  res.json({ nonce, expiresAt });
});

function verifyAndConsumeNonce(nonce) {
  const exp = nonces.get(nonce);
  if (!exp) return false;
  nonces.delete(nonce);
  return Date.now() <= exp;
}

function verifySignature({ adminPublicKey, message, signature }) {
  try {
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = Uint8Array.from(Buffer.from(signature, "base64"));
    const pubkeyBytes = new PublicKey(adminPublicKey).toBytes();
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

function getCreatorWalletBytes() {
  try {
    return new PublicKey(process.env.CREATOR_WALLET).toBytes();
  } catch {
    return null;
  }
}

app.post("/wallet-approve", async (req, res) => {
  const { videoId, adminPublicKey, signature, nonce } = req.body || {};
  if (!videoId || !adminPublicKey || !signature || !nonce) return res.status(400).json({ error: "Missing fields" });
  if (!verifyAndConsumeNonce(nonce)) return res.status(400).json({ error: "Invalid nonce" });

  const expected = getCreatorWalletBytes();
  if (!expected) return res.status(500).json({ error: "CREATOR_WALLET invalid" });

  const msg = `approve:${videoId}:${nonce}`;
  const ok = verifySignature({ adminPublicKey, message: msg, signature });
  if (!ok) return res.status(401).json({ error: "Bad signature" });

  // Ensure pubkey matches CREATOR_WALLET
  try {
    const provided = new PublicKey(adminPublicKey);
    const expectedPk = new PublicKey(process.env.CREATOR_WALLET);
    if (!provided.equals(expectedPk)) return res.status(401).json({ error: "Unauthorized wallet" });
  } catch {
    return res.status(400).json({ error: "Invalid adminPublicKey" });
  }

  db.run(`UPDATE videos SET status = 'approved' WHERE id = ?`, [videoId], function(err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true });
  });
});

app.post("/wallet-reject", async (req, res) => {
  const { videoId, adminPublicKey, signature, nonce } = req.body || {};
  if (!videoId || !adminPublicKey || !signature || !nonce) return res.status(400).json({ error: "Missing fields" });
  if (!verifyAndConsumeNonce(nonce)) return res.status(400).json({ error: "Invalid nonce" });

  const expected = getCreatorWalletBytes();
  if (!expected) return res.status(500).json({ error: "CREATOR_WALLET invalid" });

  const msg = `reject:${videoId}:${nonce}`;
  const ok = verifySignature({ adminPublicKey, message: msg, signature });
  if (!ok) return res.status(401).json({ error: "Bad signature" });

  try {
    const provided = new PublicKey(adminPublicKey);
    const expectedPk = new PublicKey(process.env.CREATOR_WALLET);
    if (!provided.equals(expectedPk)) return res.status(401).json({ error: "Unauthorized wallet" });
  } catch {
    return res.status(400).json({ error: "Invalid adminPublicKey" });
  }

  db.run(`UPDATE videos SET status = 'rejected' WHERE id = ?`, [videoId], function(err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true });
  });
});

// ------------------------------
// 🔹 Basic Admin HTML Page
// ------------------------------
app.get("/admin", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - Pending Videos</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    input, button { padding: 8px; margin: 4px 0; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 10px 0; }
    .row { display: flex; gap: 12px; align-items: center; }
    img.thumb { width: 120px; height: 68px; object-fit: cover; border-radius: 6px; border:1px solid #ccc; }
    .meta { font-size: 12px; color: #555; }
  </style>
  <script>
    function getKey() { return localStorage.getItem('adminKey') || ''; }
    function setKey(v) { localStorage.setItem('adminKey', v); }

    async function act(id, action) {
      const key = getKey();
      await fetch('/videos/' + id + '/' + action, { method: 'POST', headers: { 'x-admin-key': key } });
      await load();
    }

    async function load() {
      const key = getKey();
      var k = document.getElementById('k');
      if (k) k.value = key;
      const resp = await fetch('/videos/pending', { headers: { 'x-admin-key': key } });
      if (!resp.ok) {
        const list = document.getElementById('list');
        list.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'card';
        msg.textContent = 'Error ' + resp.status + ' — ' + (resp.status === 401 ? 'Unauthorized: enter correct admin key and Save' : 'Failed to load pending');
        list.appendChild(msg);
        return;
      }
      const data = await resp.json();
      const list = document.getElementById('list');
      list.innerHTML = '';
      const arr = Array.isArray(data) ? data : [];
      if (arr.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'card';
        empty.textContent = 'No pending videos yet.';
        list.appendChild(empty);
        return;
      }
      arr.forEach(function(v) {
        const card = document.createElement('div');
        card.className = 'card';

        const row = document.createElement('div');
        row.className = 'row';
        card.appendChild(row);

        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = v.thumbnailUrl;
        row.appendChild(img);

        const right = document.createElement('div');
        row.appendChild(right);

        const title = document.createElement('div');
        title.innerHTML = '<strong>' + v.title + '</strong>';
        right.appendChild(title);

        const owner = document.createElement('div');
        owner.className = 'meta';
        owner.textContent = 'Owner: ' + v.ownerPublicKey;
        right.appendChild(owner);

        const rate = document.createElement('div');
        rate.className = 'meta';
        rate.textContent = v.lamportsPerSecond + ' lamports/s';
        right.appendChild(rate);

        const link = document.createElement('div');
        link.className = 'meta';
        link.innerHTML = '<a href="' + v.videoUrl + '" target="_blank">Open Video</a>';
        right.appendChild(link);

        const created = document.createElement('div');
        created.className = 'meta';
        try { created.textContent = 'Created: ' + new Date(v.createdAt).toLocaleString(); } catch(e) {}
        right.appendChild(created);

        const actions = document.createElement('div');
        actions.style.marginTop = '8px';
        right.appendChild(actions);

        const approveBtn = document.createElement('button');
        approveBtn.textContent = 'Approve';
        approveBtn.addEventListener('click', function(){ act(v.id, 'approve'); });
        actions.appendChild(approveBtn);

        const rejectBtn = document.createElement('button');
        rejectBtn.textContent = 'Reject';
        rejectBtn.style.marginLeft = '8px';
        rejectBtn.addEventListener('click', function(){ act(v.id, 'reject'); });
        actions.appendChild(rejectBtn);

        list.appendChild(card);
      });
    }

    window.addEventListener('DOMContentLoaded', function(){
      var btn = document.getElementById('saveBtn');
      if (btn) btn.addEventListener('click', function(){
        setKey(document.getElementById('k').value);
        const list = document.getElementById('list');
        list.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'card';
        msg.textContent = 'Admin key saved. Loading pending videos…';
        list.appendChild(msg);
        load();
      });
      load();
    });
  </script>
</head>
<body>
  <h1>Pending Videos</h1>
  <div>
    <label>Admin Key:</label>
    <input id="k" type="password" placeholder="enter admin key" />
    <button id="saveBtn">Save</button>
  </div>
  <div id="list"></div>
</body>
</html>`);
});

const port = Number(process.env.PORT || 4020);
app.listen(port, () => console.log(`Flow402x backend on :${port}`));
