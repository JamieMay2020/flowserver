import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

export async function getAtas(connection, usdcMint, userPubkey, creatorPubkey) {
  const userAta = await getAssociatedTokenAddress(new PublicKey(usdcMint), new PublicKey(userPubkey));
  const creatorAta = await getAssociatedTokenAddress(new PublicKey(usdcMint), new PublicKey(creatorPubkey));
  return { userAta, creatorAta };
}
