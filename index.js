import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { TransferEngine } from "./solana/transferLoop.js";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const engine = new TransferEngine(process.env);

// ------------------------------
// 🔹 Start streaming payments
// ------------------------------
app.post("/start", async (req, res) => {
  const { userPubkey } = req.body || {};
  if (!userPubkey) return res.status(400).json({ error: "Missing userPubkey" });

  try {
    engine.start(userPubkey);
    return res.json({ ok: true, status: "starting" });
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
});

// ------------------------------
// 🔹 Stop streaming
// ------------------------------
app.post("/stop", (_req, res) => {
  engine.firstTransferConfirmed = false;
  engine.stop();
  return res.json({ ok: true });
});

// ------------------------------
// 🔹 Logs & Status
// ------------------------------
app.get("/logs", (_req, res) => res.json(engine.getLogs()));
app.get("/status", (_req, res) => res.json(engine.getStatus()));

// ------------------------------
// 🔹 SQLite Setup
// ------------------------------
const db = new sqlite3.Database("./videos.sqlite");

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
// Helpers
// ------------------------------
const ALLOWED_VIDEO_HOSTS = [
  "youtube.com",
  "youtu.be",
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
      `SELECT COUNT(*) AS c FROM videos WHERE ownerPublicKey = ? AND status = 'pending'`,
      [ownerPublicKey],
      (err, row) => (err ? reject(err) : resolve(row?.c || 0))
    );
  });
}

async function getLastCreatedAt(ownerPublicKey) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT createdAt FROM videos WHERE ownerPublicKey = ? ORDER BY createdAt DESC LIMIT 1`,
      [ownerPublicKey],
      (err, row) => (err ? reject(err) : resolve(row?.createdAt || 0))
    );
  });
}

// ------------------------------
// 🔹 Submit Video
// ------------------------------
app.post("/videos", async (req, res) => {
  const { ownerPublicKey, title, description, videoUrl, thumbnailUrl, lamportsPerSecond } = req.body || {};

  if (!ownerPublicKey || !title || !videoUrl || !thumbnailUrl || typeof lamportsPerSecond === "undefined") {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!isAllowedHost(videoUrl)) return res.status(400).json({ error: "Video URL host not allowed" });

  const rate = Number(lamportsPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: "Invalid lamportsPerSecond" });

  try {
    const pending = await getPendingCount(ownerPublicKey);
    if (pending >= 3) return res.status(429).json({ error: "Too many pending submissions" });

    const last = await getLastCreatedAt(ownerPublicKey);
    if (Date.now() - last < 2 * 60 * 1000) return res.status(429).json({ error: "Please wait before submitting again" });

    const now = Date.now();
    db.run(
      `INSERT INTO videos (ownerPublicKey, title, description, videoUrl, thumbnailUrl, lamportsPerSecond, createdAt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [ownerPublicKey, title.slice(0, 200), (description || '').slice(0, 2000), videoUrl, thumbnailUrl, rate, now],
      function (err) {
        if (err) return res.status(500).json({ error: "DB error" });
        return res.json({ ok: true, id: this.lastID });
      }
    );
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

// ------------------------------
// 🔹 Get Videos
// ------------------------------
app.get("/videos", (_req, res) => {
  db.all(`SELECT * FROM videos WHERE status = 'approved' ORDER BY createdAt DESC`, [], (err, rows) =>
    err ? res.status(500).json({ error: "DB error" }) : res.json(rows || [])
  );
});

// ------------------------------
// 🔹 Admin Pending List
// ------------------------------
app.get("/videos/pending", (req, res) => {
  if (requireAdmin(req, res) !== null) return;
  db.all(`SELECT * FROM videos WHERE status = 'pending' ORDER BY createdAt ASC`, [], (err, rows) =>
    err ? res.status(500).json({ error: "DB error" }) : res.json(rows || [])
  );
});

// ------------------------------
// 🔹 Approve / Reject
// ------------------------------
app.post("/videos/:id/approve", (req, res) => {
  if (requireAdmin(req, res) !== null) return;
  db.run(`UPDATE videos SET status = 'approved' WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });
    return res.json({ ok: true });
  });
});

app.post("/videos/:id/reject", (req, res) => {
  if (requireAdmin(req, res) !== null) return;
  db.run(`UPDATE videos SET status = 'rejected' WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });
    return res.json({ ok: true });
  });
});

// ------------------------------
// 🔹 Admin Page (String.raw prevents template-break)
// ------------------------------
app.get("/admin", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(String.raw`
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Admin</title>
<style>
body { font-family: sans-serif; max-width: 800px; margin: 24px auto; }
.card { border:1px solid #ccc; padding:12px; border-radius:6px; margin-bottom:12px; }
img.thumb { width:140px; height:80px; object-fit:cover; border-radius:4px; }
</style>
<script>
function getKey(){ return localStorage.getItem("adminKey") || ""; }
function setKey(k){ localStorage.setItem("adminKey", k); }

async function act(id, action){
  const key = getKey();
  await fetch("/videos/" + id + "/" + action, { method:"POST", headers: { "x-admin-key": key } });
  load();
}

function saveKey(){
  setKey(document.getElementById("k").value);
  load();
}

async function load(){
  const key = getKey();
  document.getElementById("k").value = key;
  const resp = await fetch("/videos/pending", { headers:{ "x-admin-key": key }});
  const data = await resp.json();
  const list = document.getElementById("list");
  list.innerHTML = "";
  (data||[]).forEach(v=>{
    list.innerHTML += `
    <div class="card">
      <img class="thumb" src="${v.thumbnailUrl}">
      <strong>${v.title}</strong><br>
      <small>${v.ownerPublicKey}</small><br>
      <a href="${v.videoUrl}" target="_blank">View Video</a><br><br>
      <button onclick="act(${v.id}, 'approve')">Approve</button>
      <button onclick="act(${v.id}, 'reject')">Reject</button>
    </div>`;
  });
}
window.onload = load;
</script>
</head>
<body>
<h1>Pending Videos</h1>
<input id="k" type="password" placeholder="Admin Key"><button onclick="saveKey()">Save</button>
<div id="list"></div>
</body>
</html>
  `);
});

// ------------------------------
const port = Number(process.env.PORT || 4020);
app.listen(port, () => console.log(`Flow402x backend on :${port}`));
