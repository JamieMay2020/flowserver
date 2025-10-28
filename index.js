import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { TransferEngine } from "./solana/transferLoop.js";

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

// ------------------------------
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

const port = Number(process.env.PORT || 4020);
app.listen(port, () => console.log(`Flow402x backend on :${port}`));
