import { Connection, Keypair, PublicKey, clusterApiUrl, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getAtas, getTokenMint, getTokenDecimals } from "./helpers.js";

const LOG_SIZE = 200;
const TICK_INTERVAL_MS = 2000;

class BlockhashCache {
  constructor(connection) {
    this.connection = connection;
    this.blockhash = null;
    this.lastValidBlockHeight = null;
    this.lastFetch = 0;
    this.CACHE_DURATION = 25000;
  }

  async get() {
    const now = Date.now();
    if (!this.blockhash || (now - this.lastFetch) > this.CACHE_DURATION) {
      const result = await this.connection.getLatestBlockhash("confirmed");
      this.blockhash = result.blockhash;
      this.lastValidBlockHeight = result.lastValidBlockHeight;
      this.lastFetch = now;
      return result;
    }
    return { blockhash: this.blockhash, lastValidBlockHeight: this.lastValidBlockHeight };
  }

  clear() {
    this.blockhash = null;
    this.lastValidBlockHeight = null;
    this.lastFetch = 0;
  }
}

export class TransferEngine {
  constructor(env, settings = {}) {
    const rpcUrl = env.RPC_URL || clusterApiUrl("mainnet-beta");
    this.connection = new Connection(rpcUrl, "confirmed");
    console.log(`RPC: ${rpcUrl.replace(/api-key=.*/, "api-key=***")}`);

    this.blockhashCache = new BlockhashCache(this.connection);
    this.gatewayKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.GATEWAY_SECRET_KEY)));
    this.perSecond = Number(env.LAMPORTS_PER_SECOND || "1000");

    const walletStr = settings.agentWallet || env.AGENT_WALLET;
    this.agentWallet = walletStr ? new PublicKey(walletStr) : null;

    this.intervalId = null;
    this.logs = [];
    this.transferCount = 0;
    this.firstTransferConfirmed = false;

    this.mint = getTokenMint(settings.tokenMint);
    this.decimals = getTokenDecimals();

    this.userAta = null;
    this.creatorAta = null;
    this.agentAta = null;
    this.creatorWallet = null;
    this.userPubkey = null;
    this.lastSignature = null;
  }

  updateConfig({ tokenMint, agentWallet }) {
    if (tokenMint !== undefined) {
      this.mint = getTokenMint(tokenMint || undefined);
      this.decimals = getTokenDecimals();
    }
    if (agentWallet !== undefined) {
      this.agentWallet = agentWallet ? new PublicKey(agentWallet) : null;
    }
    this.log(`⚙ Config updated — mint: ${this.mint.toString()}, agent: ${this.agentWallet?.toString() || "none"}`);
  }

  log(line, txId = null) {
    const entry = txId ? { text: line, txId } : { text: line };
    console.log(`[FLOW] ${line}${txId ? ` (${txId})` : ""}`);
    this.logs.push(entry);
    if (this.logs.length > LOG_SIZE) this.logs.shift();
  }

  async start(userPubkey, creatorWallet) {
    if (this.intervalId) throw new Error("Stream already running");

    this.logs = [];
    this.userPubkey = userPubkey;
    this.creatorWallet = new PublicKey(creatorWallet);
    this.transferCount = 0;
    this.firstTransferConfirmed = false;

    const agentPubkey = this.agentWallet || this.creatorWallet;

    const { userAta, creatorAta, agentAta } = await getAtas(
      this.mint,
      userPubkey,
      creatorWallet,
      agentPubkey
    );

    this.userAta = userAta;
    this.creatorAta = creatorAta;
    this.agentAta = agentAta;

    this.log("▶ Stream started");

    this.intervalId = setInterval(() => {
      this.executeTransfer().catch(() => {});
    }, TICK_INTERVAL_MS);
  }

  async executeTransfer() {
    try {
      this.transferCount++;

      if (this.transferCount % 10 === 0) {
        this.blockhashCache.clear();
      }

      const { blockhash } = await this.blockhashCache.get();
      if (!blockhash) {
        this.blockhashCache.clear();
        return;
      }

      const tickAmount = this.perSecond * (TICK_INTERVAL_MS / 1000);
      const creatorAmount = Math.floor(tickAmount / 2);
      const agentAmount = tickAmount - creatorAmount;

      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.gatewayKey.publicKey;

      tx.add(
        createTransferCheckedInstruction(
          this.userAta,
          this.mint,
          this.creatorAta,
          this.gatewayKey.publicKey,
          creatorAmount,
          this.decimals,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      if (this.agentAta && this.agentWallet) {
        tx.add(
          createTransferCheckedInstruction(
            this.userAta,
            this.mint,
            this.agentAta,
            this.gatewayKey.publicKey,
            agentAmount,
            this.decimals,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }

      tx.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          data: Buffer.from(`flow402-${Date.now()}`),
        })
      );

      tx.sign(this.gatewayKey);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
      });

      this.lastSignature = sig;

      const solAmount = tickAmount / 1e9;
      const shortSig = `${sig.slice(0, 4)}...${sig.slice(-4)}`;
      const splitLabel = this.agentWallet
        ? `${(creatorAmount / 1e9).toFixed(6)} creator | ${(agentAmount / 1e9).toFixed(6)} burn`
        : `${solAmount.toFixed(6)} creator`;

      this.log(`✔ ${solAmount.toFixed(6)} SOL → ${shortSig} (${splitLabel})`, sig);

      if (this.transferCount === 1) {
        try {
          await this.connection.confirmTransaction(sig, "confirmed");
        } catch (_) {
          // confirmation timeout is non-fatal
        }
        this.firstTransferConfirmed = true;
      }

    } catch (err) {
      if (err.message?.includes("blockhash")) this.blockhashCache.clear();
      if (this.transferCount <= 3) {
        this.log(`⚠ Transfer error: ${err.message}`);
      }
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.transferCount = 0;
      this.lastSignature = null;
      this.firstTransferConfirmed = false;
      this.log("⏹ Stream stopped");
    }
  }

  getLogs() {
    return this.logs.slice(-LOG_SIZE);
  }

  getStatus() {
    return {
      active: !!this.intervalId,
      firstTransferConfirmed: !!this.firstTransferConfirmed,
      transferCount: this.transferCount,
    };
  }
}
