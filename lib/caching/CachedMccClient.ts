import { AlgoMccCreate, ChainType, MCC, RPCInterface, UtxoMccCreate, XrpMccCreate } from "flare-mcc";
import { Queue } from "../utils/Queue";

export interface CachedMccClientOptions {
  transactionCacheSize: number;
  blockCacheSize: number;
  cleanupChunkSize: number;
     // maximum number of requests that are either in processing or in queue
  activeLimit: number; 
  clientConfig: AlgoMccCreate | UtxoMccCreate | XrpMccCreate;
  // onChange?: (inProcessing?: number, inQueue?: number) => void;
}

let defaultCachedMccClientOptions: CachedMccClientOptions = {
  transactionCacheSize: 100000,
  blockCacheSize: 100000,
  cleanupChunkSize: 100,
  activeLimit: 50, 
  clientConfig: {} as any
}

// Usage:
// 1) External service should initialize relevant MCC client through CachedMccClient wrapper class
// 2) Services should use the following call sequence
//   (a) try calling `getTransactionFromCache` or `getBlockFromCache`
//   (b) if response is null, then check `canAccept`. 
//        (i) If `true` is returned, call `getTransaction` (`getBlock`)
//        (ii) if `false` is returned, sleep for a while and retry `canAccept`. Repeat this until `true` is 
//             eventually returned and then proceed with (i)

export type OnChangeCallback = (inProcessing?: number, inQueue?: number) => void
export class CachedMccClient<T, B> {
  client: RPCInterface;
  chainType: ChainType;

  transactionCache: Map<string, Promise<T>>;
  transactionCleanupQueue: Queue<string>;

  blockCache: Map<string | number, Promise<B>>;
  blockCleanupQueue: Queue<string>;

  settings: CachedMccClientOptions;

  inProcessing = 0;
  inQueue = 0;

  cleanupCheckCounter = 0;

  onChangeCallbacks: {[key: number]: OnChangeCallback}
  onChangeCallbackCount = 0;

  constructor(chainType: ChainType, options?: CachedMccClientOptions) {
    this.chainType = chainType;
    this.transactionCache = new Map<string, Promise<T>>();
    this.transactionCleanupQueue = new Queue<string>();
    this.blockCache = new Map<string, Promise<B>>();
    this.blockCleanupQueue = new Queue<string>();

    this.settings = options || defaultCachedMccClientOptions;

    // Override onSend
    this.settings.clientConfig.rateLimitOptions = {
      ...this.settings.clientConfig.rateLimitOptions,
      onSend: this.onChange.bind(this),
      onResponse: this.onChange.bind(this)
    }

    this.client = MCC.Client(this.chainType, this.settings.clientConfig) as any as RPCInterface // TODO
  }

  private onChange(inProcessing?: number, inQueue?: number) {
    this.inProcessing = inProcessing;
    this.inQueue = inQueue;
    // Call all registered callbacks
    for(let id in this.onChangeCallbacks) {
      this.onChangeCallbacks[id](inProcessing, inQueue);
    }
  }

  registerOnChangeCallback(callback: OnChangeCallback): number {
    let id = this.onChangeCallbackCount;
    this.onChangeCallbacks[id] = callback;
    this.onChangeCallbackCount++;
    return id;    
  }

  unregisterOnChangeCallback(id: number) {
    delete this.onChangeCallbacks[id];
  }

  // returns T or null
  public getTransactionFromCache(txId: string): Promise<T> | undefined {
    return this.transactionCache.get(txId);
  }

  public async getTransaction(txId: string) {
    // if(!this.canAccept) {
    //   throw Error("Cannot accept transaction requests");
    // }
    let txPromise = this.getTransactionFromCache(txId);
    if(txPromise) {
      return txPromise;
    }
    let newPromise = this.client.getTransaction(txId);
    this.transactionCache.set(txId, newPromise);
    this.checkAndCleanup();
    return newPromise;    
  }

  public async getBlockFromCache(blockHash: string) {
    return this.blockCache.get(blockHash)
  }

  public async getBlock(blockHashOrNumber: string | number): Promise<B | null> {
    // if(!this.canAccept) {
    //   throw Error("Cannot accept block requests");
    // }
    let blockPromise = this.blockCache.get(blockHashOrNumber);
    if(blockPromise) {
      return blockPromise;
    }

    // MCC client should support hash queries
    let newPromise = this.client.getBlock(blockHashOrNumber);
    if(typeof blockHashOrNumber === "number") {
      let block = await newPromise;
      let blockHash = block.hash // TODO
      this.blockCache.set(blockHash, newPromise); 
    } else {
      this.blockCache.set(blockHashOrNumber, newPromise); 
    }    
    this.checkAndCleanup();
    return newPromise;    
  }

  public get canAccept(): boolean {
    return !this.settings.activeLimit || this.inProcessing + this.inQueue <= this.settings.activeLimit;
  }

  private checkAndCleanup() {
    this.cleanupCheckCounter++;
    if(this.cleanupCheckCounter >= this.settings.cleanupChunkSize) {
      this.cleanupCheckCounter = 0;
      setTimeout(() => this.cleanup());   // non-blocking call
    }
  }

  private cleanup() {
    if(this.blockCleanupQueue.size >= this.settings.blockCacheSize + this.settings.cleanupChunkSize) {
      while(this.blockCleanupQueue.size > this.settings.blockCacheSize) {
        this.blockCache.delete(this.blockCleanupQueue.shift())
      }  
    }
    if(this.transactionCleanupQueue.size >= this.settings.transactionCacheSize + this.settings.cleanupChunkSize) {
      while(this.transactionCleanupQueue.size > this.settings.transactionCacheSize) {
        this.transactionCache.delete(this.transactionCleanupQueue.shift())
      }
    }
  }

}