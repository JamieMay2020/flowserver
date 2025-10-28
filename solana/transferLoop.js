import { Connection, Keypair, PublicKey, clusterApiUrl, Transaction } from "@solana/web3.js";
import { 
  getAccount, 
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { getAtas } from "./helpers.js";
import { TransactionInstruction } from "@solana/web3.js";

const LOG_SIZE = 200;

class BlockhashCache {
  constructor(connection) {
    this.connection = connection;
    this.blockhash = null;
    this.lastValidBlockHeight = null;
    this.lastFetch = 0;
    this.CACHE_DURATION = 25000; // 25 seconds
  }

  async getRecentBlockhash() {
    const now = Date.now();

    // If cache missing or expired
    if (!this.blockhash || (now - this.lastFetch) > this.CACHE_DURATION) {
      const result = await this.connection.getLatestBlockhash("confirmed");
      this.blockhash = result.blockhash;
      this.lastValidBlockHeight = result.lastValidBlockHeight;
      this.lastFetch = now;
      return result;
    }

    // If cache is valid, return it
    return {
      blockhash: this.blockhash,
      lastValidBlockHeight: this.lastValidBlockHeight
    };
  }

  clear() {
    this.blockhash = null;
    this.lastValidBlockHeight = null;
    this.lastFetch = 0;
  }
}

export class TransferEngine {
  constructor(env) {
    const rpcUrl = env.RPC_URL || env.NEXT_PUBLIC_RPC_URL || clusterApiUrl("mainnet-beta");
    this.connection = new Connection(rpcUrl, "confirmed");
    console.log(`Using RPC: ${rpcUrl}`);

    this.blockhashCache = new BlockhashCache(this.connection);
    this.gatewayKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.GATEWAY_SECRET_KEY)));
    this.creatorPubkey = new PublicKey(env.CREATOR_WALLET);
    this.usdcMint = new PublicKey(env.USDC_MINT);
    this.perSecond = Number(env.LAMPORTS_PER_SECOND || "1000000");
    this.intervalId = null;
    this.logs = [];
    this.userAta = null;
    this.creatorAta = null;
    this.lastSignature = null;
    this.transferCount = 0;
    this.userPubkey = null;
    this.firstTransferConfirmed = false;
  }

  log(line, txId = null) {
    const logLine = txId ? { text: line, txId } : { text: line };
    console.log(`[LOG] ${line}${txId ? ` (${txId})` : ''}`);
    this.logs.push(logLine);
    if (this.logs.length > LOG_SIZE) this.logs.shift();
  }

  async start(userPubkey) {
    if (this.intervalId) throw new Error("Loop already running");
    this.logs = [];
    this.userPubkey = userPubkey;
    
    const { userAta, creatorAta } = await getAtas(
      this.connection, 
      this.usdcMint, 
      userPubkey, 
      this.creatorPubkey
    );
    
    this.userAta = userAta;
    this.creatorAta = creatorAta;
    this.transferCount = 0;
    this.firstTransferConfirmed = false;
    
    this.log(`▶ Stream started`);

    this.intervalId = setInterval(async () => {
      await this.executeTransfer();
    }, 5000);
  }

  async executeTransfer() {
    try {
      this.transferCount++;

      if (this.transferCount % 10 === 0) {
        this.blockhashCache.clear();
      }

      const { blockhash } = await this.blockhashCache.getRecentBlockhash();
      if (!blockhash) {
        this.blockhashCache.clear();
        return;
      }

      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.gatewayKey.publicKey;

      tx.add(
        createTransferCheckedInstruction(
          this.userAta,
          this.usdcMint,
          this.creatorAta,
          this.gatewayKey.publicKey,
          this.perSecond * 5,
          6,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      // Add memo instruction for uniqueness
      tx.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          data: Buffer.from(`flow402x-${Date.now()}`)
        })
      );

      tx.sign(this.gatewayKey);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 0
      });

      this.lastSignature = sig;
      
      // Format: ✔ Sent 2 FLOW → [shortSig] (with full txId for linking)
      const tokenAmount = (this.perSecond * 5) / 1_000_000;
      const shortSig = `${sig.substring(0, 4)}...${sig.substring(sig.length - 4)}`;
      this.log(`✔ Sent ${tokenAmount} FLOW → ${shortSig}`, sig);
      
      if (this.transferCount === 1) {
        this.firstTransferConfirmed = true;
      }

    } catch (err) {
      // Silent failure - no logs for errors
      if (err.message.includes("blockhash")) this.blockhashCache.clear();
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
