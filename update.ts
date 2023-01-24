import fs from 'fs';
import bs58 from "bs58";
import path from 'path';
import "dotenv/config";

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, TransactionInstruction } from "@solana/web3.js";
import { createUpdateMetadataAccountV2Instruction, PROGRAM_ID as MPL_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata"
import { lamports, toMetadataAccount } from '@metaplex-foundation/js';

// Hashlist file name without .json, as an array of base58 public key strings
const INPUT_NFT_HASHLIST_FILE_NAME = "testHashlist";
// Collection key, as a base58 public key string
const COLLECTION_KEY = new PublicKey("1W1MqiPSDTSBiWGp4N653AAU28HYkj8SBGz7uSonsCa");
// Royalties wallet, as a base58 public key string
const ROYALTIES_WALLET = new PublicKey("1W1MqiPSDTSBiWGp4N653AAU28HYkj8SBGz7uSonsCa");
// Your hashlist
const nftList: PublicKey[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "hashLists/",`${INPUT_NFT_HASHLIST_FILE_NAME}.json`)).toString()).map((nft: string) => new PublicKey(nft));
// Set to false to actually update the metadata, set to true to just print the formatted/updated data. Highly recommend checking before running. Or let it rip. What's the worst that could happen?
let preventUpdate = false;

// We utilize a round robin here for connections to reduce liklihood of 429's. If you don't have a lot of RPCs, get more :) Or get better rpcs.
const connections: Connection[] = [];
const conn1 = new Connection(process.env.RPC1, "confirmed");
const conn2 = new Connection(process.env.RPC2, "confirmed");
const conn3 = new Connection(process.env.RPC3, "confirmed");
connections.push(conn1);
connections.push(conn2);
connections.push(conn3);


type UpdatableObject = {
    tokenPubkey: PublicKey;
    tokenMetadataAccount: PublicKey;
    currentTokenMetadata?: any;
    tokenMetadataURI?: string;
    newTokenMetadata?: any;
    updateMetadataIX?: TransactionInstruction;
}
async function run() {
    // Treasury in .env, uses bs58 private key format currently, feel free to use a uint8 array instead.
    const fromWallet = getKeypair();
    console.log("From wallet generated at:", fromWallet.publicKey.toString());

    // Gets an array of token mint addresses and their corresponding metadata account addresses
    const updateList: UpdatableObject[] = await Promise.all(nftList.map(async (nft: PublicKey) => {
        const [tokenMetadataAccount, bump] = PublicKey.findProgramAddressSync(
            [Buffer.from('metadata', 'utf-8'), MPL_PROGRAM_ID.toBuffer(), nft.toBuffer()],
            MPL_PROGRAM_ID
        );
        return {
            tokenPubkey: nft,
            tokenMetadataAccount: tokenMetadataAccount,
        }
    }));

    // Puts the metadata account addresses into batches of 100 for getMultipleAccounts
    const METADATA_FETCH_BATCH_SIZE = 100; // Max limit for getMultipleAccounts is 100
    const METADATA_FETCH_BATCH_COUNT = Math.ceil(updateList.length / METADATA_FETCH_BATCH_SIZE);
    const metadataAccountBatches = [];
    for (let i = 0; i < METADATA_FETCH_BATCH_COUNT; i++) {
        const batch = updateList.slice(i * METADATA_FETCH_BATCH_SIZE, (i + 1) * METADATA_FETCH_BATCH_SIZE);
        metadataAccountBatches.push(batch);
    }

    // Gets the actual metadata after calling getMultipleAccounts, formats it, updates it, and creates the update instruction
    await Promise.all(metadataAccountBatches.map(async (batchMetadataAccounts: UpdatableObject[], index) => {
        await connections[index % connections.length].getMultipleAccountsInfo(batchMetadataAccounts.map((batchMetadataAccount: UpdatableObject) => batchMetadataAccount.tokenMetadataAccount))
            .then((batchedRawTokenMetadata: any) => {
                console.log(`Batch ${index} of ${METADATA_FETCH_BATCH_COUNT} fetched.`)
                batchedRawTokenMetadata.forEach((rawTokenMetadataObj: any, innerIndex: number) => {
                    console.log(`Batch ${index} of ${METADATA_FETCH_BATCH_COUNT} - Token ${innerIndex} of ${batchMetadataAccounts.length} fetched.`)
                    // Formats it into how the metaplex js function expects it
                    const formattedRawTokenMetadataAccount = {
                        ...rawTokenMetadataObj,
                        publicKey: updateList[(index * 100) + innerIndex].tokenMetadataAccount,
                        exists: true,
                        lamports: lamports(rawTokenMetadataObj.lamports),
                    }
                    const tokenMetadata = toMetadataAccount(formattedRawTokenMetadataAccount);
                    if (tokenMetadata) {
                        const tokenMetadataURI = tokenMetadata.data.data.uri
                        const tokenName = tokenMetadata.data.data.name
                        const tokenSymbol = tokenMetadata.data.data.symbol
                        const tokenCreators = tokenMetadata.data.data.creators.map((creator: any) => {
                            return {
                                address: new PublicKey(creator.address),
                                verified: creator.verified,
                                share: creator.share,
                            }
                        });
                        const currentTokenMetadata = {
                            name: tokenName,
                            symbol: tokenSymbol,
                            uri: tokenMetadataURI,
                            sellerFeeBasisPoints: tokenMetadata.data.data.sellerFeeBasisPoints,
                            creators: tokenCreators,
                            uses: null,
                            collection: { // If there is already a collection, otherwise collection: null.
                                verified: true,
                                key: COLLECTION_KEY
                            }
                        }
                        updateList[(index * 100) + innerIndex].currentTokenMetadata = currentTokenMetadata;
                        // Here we're updating the creators array to add a new royalties wallet, but you can do whatever you want
                        const newTokenCreators = [...tokenCreators];
                        // if (tokenCreators.length < 3) {
                        //     newTokenCreators.push({
                        //         address: ROYALTIES_WALLET,
                        //         share: 100,
                        //         verified: false
                        //     })
                        //     newTokenCreators[1].share = 0;
                        // }
                        const newTokenMetadata = {
                            name: tokenName,
                            symbol: tokenSymbol,
                            uri: tokenMetadataURI,
                            sellerFeeBasisPoints: tokenMetadata.data.data.sellerFeeBasisPoints,
                            creators: newTokenCreators,
                            uses: null,
                            collection: {
                                verified: true,
                                key: COLLECTION_KEY
                            }
                        }
                        updateList[(index * 100) + innerIndex].newTokenMetadata = newTokenMetadata;
                        const updateMetadataV2Ix = createUpdateMetadataAccountV2Instruction(
                            {
                                metadata: updateList[(index * 100) + innerIndex].tokenMetadataAccount,
                                updateAuthority: fromWallet.publicKey
                            },
                            {
                                updateMetadataAccountArgsV2: {
                                    data: newTokenMetadata,
                                    updateAuthority: fromWallet.publicKey,
                                    primarySaleHappened: true,
                                    isMutable: true
                                }
                            }
                        )
                        updateList[(index * 100) + innerIndex].updateMetadataIX = updateMetadataV2Ix;
                    }
                })
            });
    }));

    console.log(`Example NFT Metadata: ${JSON.stringify(updateList[Math.floor(Math.random() * updateList.length)], null, 2)}`);

    fs.writeFileSync("updateList.json", JSON.stringify(updateList, null, 2));

    // Updates the metadata, set preventUpdate to true to just see the metadata that would be updated
    if (!preventUpdate) {

        await timeout(5000);
        const BUCKET_SIZE = 2; // Max is 2
        let remainingTransactions = generateTransactionBatch(updateList, BUCKET_SIZE);
        const updatedNFTs: UpdatableObject[] = [];
        while (remainingTransactions.length > 0) {
            console.log("Sending remaining transactions", remainingTransactions.length)
            const newFailedTxs = [];
            await Promise.all(remainingTransactions.map(async (transaction, index) => {
                // Sets a stagger timeout, pretty naive, but works well for RPC's that are not rate limited. If you do get 429's, you can increase the timeout here and at the end of the loop (to let it cool down)
                await timeout(10 * index)
                const success = await sendTransaction(transaction, fromWallet, index);
                if (!success) {
                    newFailedTxs.push(transaction);
                }
                else {
                    const bucket = updateList.slice(index * BUCKET_SIZE, (index + 1) * BUCKET_SIZE);
                    bucket.forEach((receivableObj: UpdatableObject) => {
                        updatedNFTs.push(receivableObj);
                    })
                }
            }));
            // fs.writeFileSync("updatedNFTs.json", JSON.stringify(sentNfts, null, 2));
            console.log("Failed transactions", newFailedTxs.length)
            remainingTransactions = newFailedTxs;
            await timeout(4000);
        }
    }

    else {
        console.log("Not updating NFTs, exiting");
    }

}

// Returns an array of transactions, each transaction containing a max of bucketSize instructions. Helpful for optimizing transaction sends, or keeping instructions that require atomicity together
const generateTransactionBatch = (updateList: UpdatableObject[], bucketSize = 2) => {
    const BUCKET_COUNT = Math.ceil(updateList.length / bucketSize);
    const transactions = [];
    for (let i = 0; i < BUCKET_COUNT; i++) {
        const bucket = updateList.slice(i * bucketSize, (i + 1) * bucketSize);
        const transaction = new Transaction();

        // Flatmap here, you can add more instructions per object (i.e. createATA, transfer, closeATA for airdropping NFTs)
        const bucketInstructions = bucket.map((nftToUpdateObj: UpdatableObject) => {
            return [nftToUpdateObj.updateMetadataIX];
        });
        const bucketInstructionsFlat = bucketInstructions.flat();
        transaction.add(...bucketInstructionsFlat);
        transactions.push(transaction);
    }
    return transactions;
}

// Sends a transaction, and returns true if successful, false if not. We retry sending after all transactions have been tried, so that our rpcs can cool down.
const sendTransaction = async (transaction: Transaction, fromWallet: Keypair, index: number) => {
    try {
        const txToSend = transaction;
        console.log(`Sending transaction for bucket #${index} on connection #${index % 3} to endpoints: ${connections[index % connections.length].rpcEndpoint}`);
        const txid = await sendAndConfirmTransaction(connections[index % 3], txToSend, [fromWallet],
            // {
            //     skipPreflight: true,
            // }
        );
        console.log(`Transaction sent for bucket #${index} with txid: ${txid}`);
        return true;
    } catch (error) {
        console.log("Error sending transaction", error);
        return false;
    }

}

// Sleep function
function timeout(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns Keypair from env variable, or generates a new one
function getKeypair() {
    console.log("Generating Keypair");
    if (process.env.TREASURY != null) {
        //import raw file
        return Keypair.fromSecretKey(bs58.decode(process.env.TREASURY)); //Decodes into a buffer, used as the signer
    }
    else {
        return Keypair.generate();
    }
}

run();