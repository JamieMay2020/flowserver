import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { TransferEngine } from "./solana/transferLoop.js";
import { getTokenMint, getTokenDecimals } from "./solana/helpers.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = join(__dirname, "content.json");
const SETTINGS_PATH = join(__dirname, "settings.json");

const app = express();
app.use(cors());
app.use(express.json());

function loadSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch (_) {}
  return { tokenMint: "", agentWallet: "" };
}

function saveSettings(settings) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function isValidPublicKey(str) {
  if (!str || str === "") return true;
  try {
    new PublicKey(str);
    return true;
  } catch {
    return false;
  }
}

function getLiveTokenMint() {
  const settings = loadSettings();
  if (settings.tokenMint) return settings.tokenMint;
  return getTokenMint().toString();
}

function getLiveAgentWallet() {
  const settings = loadSettings();
  if (settings.agentWallet) return settings.agentWallet;
  return process.env.AGENT_WALLET || null;
}

const engine = new TransferEngine(process.env, loadSettings());

function loadContent() {
  const raw = readFileSync(CONTENT_PATH, "utf-8");
  return JSON.parse(raw);
}

function saveContent(items) {
  writeFileSync(CONTENT_PATH, JSON.stringify(items, null, 2));
}

function requireAgentKey(req, res, next) {
  const key = process.env.AGENT_API_KEY;
  if (!key) return res.status(503).json({ error: "Agent API not configured" });

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${key}`) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

app.get("/config", (_req, res) => {
  return res.json({
    tokenMint: getLiveTokenMint(),
    tokenDecimals: getTokenDecimals(),
    ratePerSecond: Number(process.env.LAMPORTS_PER_SECOND || "1000"),
    agentWallet: getLiveAgentWallet(),
    supportedTypes: ["video", "feed", "analysis"],
    version: "0.2.0",
  });
});

app.get("/content", (_req, res) => {
  try {
    const items = loadContent().filter(
      (c) => !c.status || c.status === "live"
    );
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: "Failed to load content" });
  }
});

app.get("/content/:id", (req, res) => {
  try {
    const items = loadContent();
    const item = items.find((c) => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (e) {
    return res.status(500).json({ error: "Failed to load content" });
  }
});

app.post("/agent/publish", requireAgentKey, (req, res) => {
  const { title, description, type, body, wallet, ratePerSecond, entries } = req.body || {};

  if (!title) return res.status(400).json({ error: "Missing title" });
  if (!type || !["feed", "analysis", "video"].includes(type)) {
    return res.status(400).json({ error: "Invalid type. Must be feed, analysis, or video" });
  }
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

  const id = `agent-${randomBytes(6).toString("hex")}`;
  const item = {
    id,
    title,
    description: description || "",
    type,
    creatorWallet: wallet,
    creatorName: req.body.agentName || "AI Agent",
    isAgent: true,
    ratePerSecond: ratePerSecond || 1000,
  };

  if (type === "feed") {
    item.entries = Array.isArray(entries) ? entries : body
      ? [{ timestamp: new Date().toISOString(), text: body }]
      : [];
  } else if (type === "analysis") {
    item.body = body || "";
  } else if (type === "video") {
    item.videoUrl = req.body.videoUrl || "";
    item.thumbnailUrl = req.body.thumbnailUrl || "";
    item.durationSeconds = req.body.durationSeconds || 0;
  }

  try {
    const items = loadContent();
    items.push(item);
    saveContent(items);
    console.log(`[AGENT] Published: ${id} — "${title}" (${type})`);
    return res.json({ ok: true, id, status: "pending_review" });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save content" });
  }
});

app.put("/agent/publish/:id", requireAgentKey, (req, res) => {
  const { body, entries } = req.body || {};

  try {
    const items = loadContent();
    const item = items.find((c) => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    if (item.type === "feed" && entries) {
      item.entries = [...(item.entries || []), ...entries];
    } else if (body) {
      item.body = body;
    }

    saveContent(items);
    console.log(`[AGENT] Updated: ${req.params.id}`);
    return res.json({ ok: true, id: req.params.id });
  } catch (e) {
    return res.status(500).json({ error: "Failed to update content" });
  }
});

app.get("/agent/status/:id", (req, res) => {
  try {
    const items = loadContent();
    const item = items.find((c) => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json({
      id: item.id,
      title: item.title,
      type: item.type,
      status: "live",
      earnings: { total: 0, currency: "SOL" },
    });
  } catch (e) {
    return res.status(500).json({ error: "Failed to load status" });
  }
});

app.post("/submit", (req, res) => {
  const { title, description, type, body, wallet, creatorName } = req.body || {};

  if (!title) return res.status(400).json({ error: "Missing title" });
  if (!type || !["feed", "analysis", "video"].includes(type)) {
    return res.status(400).json({ error: "Invalid type. Must be feed, analysis, or video" });
  }
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });

  const id = `sub-${randomBytes(6).toString("hex")}`;
  const item = {
    id,
    title,
    description: description || "",
    type,
    creatorWallet: wallet,
    creatorName: creatorName || "Anonymous",
    isAgent: false,
    ratePerSecond: 1000,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };

  if (type === "feed") {
    item.entries = body
      ? [{ timestamp: new Date().toISOString(), text: body }]
      : [];
  } else if (type === "analysis") {
    item.body = body || "";
  } else if (type === "video") {
    item.videoUrl = req.body.videoUrl || "";
    item.thumbnailUrl = req.body.thumbnailUrl || "";
    item.durationSeconds = req.body.durationSeconds || 0;
  }

  try {
    const items = loadContent();
    items.push(item);
    saveContent(items);
    console.log(`[SUBMIT] Pending: ${id} — "${title}" (${type})`);
    return res.json({ ok: true, id, status: "pending" });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save submission" });
  }
});

app.get("/admin/pending", requireAgentKey, (_req, res) => {
  try {
    const items = loadContent().filter((c) => c.status === "pending");
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: "Failed to load pending items" });
  }
});

app.post("/admin/approve/:id", requireAgentKey, (req, res) => {
  try {
    const items = loadContent();
    const item = items.find((c) => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    item.status = "live";
    saveContent(items);
    console.log(`[ADMIN] Approved: ${req.params.id} — "${item.title}"`);
    return res.json({ ok: true, id: req.params.id, status: "live" });
  } catch (e) {
    return res.status(500).json({ error: "Failed to approve" });
  }
});

app.post("/admin/reject/:id", requireAgentKey, (req, res) => {
  try {
    const items = loadContent();
    const idx = items.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const removed = items.splice(idx, 1)[0];
    saveContent(items);
    console.log(`[ADMIN] Rejected: ${req.params.id} — "${removed.title}"`);
    return res.json({ ok: true, id: req.params.id, status: "rejected" });
  } catch (e) {
    return res.status(500).json({ error: "Failed to reject" });
  }
});

app.get("/admin/settings", requireAgentKey, (_req, res) => {
  const settings = loadSettings();
  return res.json({
    tokenMint: settings.tokenMint || process.env.TOKEN_MINT || "",
    agentWallet: settings.agentWallet || process.env.AGENT_WALLET || "",
  });
});

app.put("/admin/settings", requireAgentKey, (req, res) => {
  const { tokenMint, agentWallet } = req.body || {};

  if (tokenMint !== undefined && tokenMint !== "" && !isValidPublicKey(tokenMint)) {
    return res.status(400).json({ error: "Invalid token mint address" });
  }
  if (agentWallet !== undefined && agentWallet !== "" && !isValidPublicKey(agentWallet)) {
    return res.status(400).json({ error: "Invalid agent wallet address" });
  }

  try {
    const current = loadSettings();
    const updated = {
      tokenMint: tokenMint !== undefined ? tokenMint : current.tokenMint,
      agentWallet: agentWallet !== undefined ? agentWallet : current.agentWallet,
    };
    saveSettings(updated);
    engine.updateConfig(updated);
    console.log(`[ADMIN] Settings updated — mint: ${updated.tokenMint || "(native)"}, wallet: ${updated.agentWallet || "(none)"}`);
    return res.json({ ok: true, ...updated });
  } catch (e) {
    return res.status(500).json({ error: "Failed to save settings" });
  }
});

app.post("/start", async (req, res) => {
  const { userPubkey, creatorWallet } = req.body || {};
  if (!userPubkey) return res.status(400).json({ error: "Missing userPubkey" });
  if (!creatorWallet) return res.status(400).json({ error: "Missing creatorWallet" });

  try {
    await engine.start(userPubkey, creatorWallet);
    return res.json({ ok: true, status: "starting" });
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
});

app.post("/stop", (_req, res) => {
  engine.stop();
  return res.json({ ok: true });
});

app.get("/logs", (_req, res) => {
  return res.json(engine.getLogs());
});

app.get("/status", (_req, res) => {
  return res.json(engine.getStatus());
});

const port = Number(process.env.PORT || 4020);
app.listen(port, () => console.log(`flow402 backend on :${port}`));
