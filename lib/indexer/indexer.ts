
//
//
//  [ ] proof of existance (tx reference, destination address, amount)
//  
//  block (from -14d up to -6 blocks)
//     - block number
//     - block hash
//     - block timestamp
//     - response
//
//  transaction 
//     - payment reference (non unique!!!) hex string 32 chars (hex lower case)
//     - transaction id
//     - timestamp
//     - block number
//     - response
//
// search by
//     - reference
//     - hash
//     - sender address
//     
//  [ ] XRP 1st
//  [ ] 100% make sure that block is completely saved until moved to the next block
//  [ ] check if using database per chain is easier than tables per chain
//
//  [x] indexer sync - create database for x days back
//  [x] create table for each chain
//  [ ] multiple options what chains are to be started
//  [x] transaction save (with block and state) must be a transaction!
//  [x] store ALL block into DB immediately
//  [x] also save block
//  [x] 'confirmed' on all unconfirmed blocks than are less than X-this.chainConfig.confirmations
//  [x] when start N = height - 6
//  [x] all is now N oriented. I need to add into DB N+1 -> height
//  [x] we process N+1
//  [x] blockHash is changed not blockNumber
//  [x] if N+1 block is ready go and read N+2
//  [x] do not save blocks automatically but save only the ones below confirmationsIndex !!!

//  [x] keep collecting blocks while waiting for N+1 to complete


import { ChainType, IBlock, MCC, sleep } from "flare-mcc";
import { CachedMccClient, CachedMccClientOptions } from "../caching/CachedMccClient";
import { DBBlockBase } from "../entity/dbBlock";
import { DBState } from "../entity/dbState";
import { DBTransactionBase } from "../entity/dbTransaction";
import { DatabaseService } from "../utils/databaseService";
import { DotEnvExt } from "../utils/DotEnvExt";
import { AttLogger, getGlobalLogger } from "../utils/logger";
import { getUnixEpochTimestamp, round, sleepms } from "../utils/utils";
import { BlockProcessorManager } from "./blockProcessorManager";
import { prepareIndexerTables } from "./indexer-utils";
import { IndexerClientChain as IndexerChainConfiguration, IndexerConfiguration } from "./IndexerConfiguration";

var yargs = require("yargs");

const args = yargs
  .option("config", { alias: "c", type: "string", description: "Path to config json file", default: "./configs/config-indexer.json", demand: false, })
  .option("chain", { alias: "a", type: "string", description: "Chain", default: "ALGO", demand: false, })
  .argv;


class PreparedBlock {
  block: DBBlockBase;
  transactions: DBTransactionBase[];

  constructor(block: DBBlockBase, transactions: DBTransactionBase[]) {
    this.block = block;
    this.transactions = transactions;
  }
}

export class Indexer {
  config: IndexerConfiguration;
  chainConfig: IndexerChainConfiguration;
  chainType: ChainType;
  cachedClient: CachedMccClient<any, any>;
  logger!: AttLogger;
  dbService: DatabaseService;
  blockProcessorManager: BlockProcessorManager;

  // N - last processed and saved
  N = 0;
  // T - chain height
  T = 0;

  blockNp1hash = "";
  waitNp1 = false;

  preparedBlocks = new Map<number, PreparedBlock[]>();


  // statistics
  static sendCount = 0;
  static txCount = 0;
  static valid = 0;
  static invalid = 0;


  Csec2day = 60 * 60 * 24;

  dbTransactionClasses;
  dbBlockClass;

  prevEpoch = -1;
  tableLock = false;




  constructor(config: IndexerConfiguration, chainName: string) {
    this.config = config;
    this.chainType = MCC.getChainType(chainName);
    this.chainConfig = config.chains.find(el => el.name === chainName)!;

    this.logger = getGlobalLogger(chainName);

    this.dbService = new DatabaseService(this.logger);

    // todo: setup options from config
    let cachedMccClientOptions: CachedMccClientOptions = {
      transactionCacheSize: 100000,
      blockCacheSize: 100000,
      cleanupChunkSize: 100,
      activeLimit: 70,
      clientConfig: {
        url: this.chainConfig.url,
        username: this.chainConfig.username,
        password: this.chainConfig.password,
        rateLimitOptions: {
          maxRPS: this.chainConfig.maxRequestsPerSecond,
          timeoutMs: this.chainConfig.clientTimeout,
        }
      }
    };

    this.cachedClient = new CachedMccClient(this.chainType, cachedMccClientOptions);

    this.blockProcessorManager = new BlockProcessorManager(this.cachedClient, this.blockCompleted.bind(this));
  }

  get lastConfimedBlockNumber() {
    return this.N;
  }

  async waitForDBConnection() {
    while (true) {
      if (!this.dbService.connection) {
        this.logger.info("Waiting for DB connection");
        await sleep(1000);
        continue;
      }

      break;
    }
  }

  getBlockSaveEpoch(time: number): number {
    // 2022/01/01 00:00:00
    return Math.floor((time - 1640991600) / 60);
  }

  getBlock(blockNumber: number): Promise<IBlock> {
    return this.cachedClient.client.getBlock(blockNumber);
  }

  getBlockHeight(): Promise<number> {
    return this.cachedClient.client.getBlockHeight();
  }

  async blockCompleted(block: DBBlockBase, transactions: DBTransactionBase[]): Promise<boolean> {
    this.logger.info(`#${block.blockNumber}:N+${this.T - block.blockNumber} completed`)

    const isBlockNp1 = block.blockNumber == this.N + 1 && block.blockHash == this.blockNp1hash;

    if (this.waitNp1) {
      if (isBlockNp1) {

        // if we are waiting for block N+1 and this is it then no need to put it into queue but just save it

        await this.blockSave(block, transactions);

        this.waitNp1 = false;

        return;
      }
    }

    // queue it
    let processors = this.preparedBlocks.get(block.blockNumber);
    if (!processors) processors = [];
    processors.push(new PreparedBlock(block, transactions));

    // if N+1 is ready then begin processing N+2
    if (isBlockNp1) {
      const blockNp2 = await this.getBlock(this.N + 2);
      this.blockProcessorManager.process(blockNp2);
    }

    return true;
  }


  async blockSave(block: DBBlockBase, transactions: DBTransactionBase[]): Promise<boolean> {

    if (transactions.length === 0) return true;

    if (block.blockNumber !== this.N + 1) {
      // what now? PANIC
      this.logger.error2(`expected to save blockNumber ${this.N + 1} (but got ${block.blockNumber})`);
      return;
    }

    try {

      const epoch = this.getBlockSaveEpoch(transactions[0].timestamp);

      const tableIndex = epoch & 1;

      while (this.tableLock) {
        await sleepms(1);
      }

      // check if tables need to be dropped and new created
      if (this.prevEpoch !== epoch && this.prevEpoch !== -1) {

        this.tableLock = true;

        const time0 = Date.now();
        const queryRunner = this.dbService.connection.createQueryRunner();
        const tableName = `${this.chainConfig.name.toLowerCase()}_transactions${tableIndex}`;
        const table = await queryRunner.getTable(tableName);
        await queryRunner.dropTable(table);
        await queryRunner.createTable(table);
        await queryRunner.release();
        const time1 = Date.now();

        this.logger.info(`drop table '${tableName}' (time ${time1 - time0}ms)`)

        this.tableLock = false;
      }

      this.prevEpoch = epoch;

      const entity = this.dbTransactionClasses[tableIndex];

      // create a copy of data with specific data types (for database)
      // we need to make a copy so that entity class is correct
      const dataCopy = Array<typeof entity>();

      for (let d of transactions) {
        const newData = new this.dbTransactionClasses[tableIndex];

        for (let key of Object.keys(d)) {
          newData[key] = d[key];
        }

        dataCopy.push(newData)
      }

      // create transaction and save everything
      await this.dbService.connection.transaction("READ COMMITTED", async transaction => {

        // setup new N
        const state = new DBState();
        state.name = "N";
        state.valueNumber = this.N + 1;

        // block must be marked as confirmed
        await transaction.save(dataCopy);
        await transaction.save(block);
        await transaction.save(state);

        this.blockProcessorManager.clear(this.N + 1);

        // increment N if all is ok
        this.N++;

      }).catch((error) => {
        this.logger.error(`database error: ${error}`);
        return false;
      });

      return true;
    }
    catch (error) {
      this.logger.error(`saveInterlaced: ${error}`);
      return false;
    }
  }

  prepareTables() {
    let chainType = MCC.getChainType(this.chainConfig.name);
    let prepared = prepareIndexerTables(chainType);

    this.dbTransactionClasses = prepared.transactionTable;
    this.dbBlockClass = prepared.blockTable;
  }

  async getBlockNumberTimestamp(blockNumber: number): Promise<number> {
    // todo: use FAST version of block read since we only need timestamp
    const block = await this.getBlock(blockNumber) as IBlock;

    return block.unixTimestamp;
  }

  async getAverageBlocksPerDay(): Promise<number> {
    const blockNumber0 = await this.getBlockHeight() - this.chainConfig.confirmationsCollect;
    const blockNumber1 = Math.ceil(blockNumber0 * 0.9);

    // todo: check if blockNumber1 is below out range

    const time0 = await this.getBlockNumberTimestamp(blockNumber0);
    const time1 = await this.getBlockNumberTimestamp(blockNumber1);

    const time = (time0 - time1) / this.Csec2day;

    return Math.floor((blockNumber0 - blockNumber1) / time);
  }

  async getDBStartBlockNumber(): Promise<number> {
    // const entity0 = this.dbTableClass[0];
    // const entity1 = this.dbTableClass[1];

    // const res0 = await this.dbService.connection.createQueryBuilder().from(entity0, 'transactions').select('blockNumber').orderBy("id", "DESC").limit(1).getRawMany();
    // const res1 = await this.dbService.connection.createQueryBuilder().from(entity1, 'transactions').select('blockNumber').orderBy("id", "DESC").limit(1).getRawMany();

    // return Math.max(res0.length > 0 ? res0[0].blockNumber : 0, res1.length > 0 ? res1[0].blockNumber : 0);

    const res = await this.dbService.manager.findOne(DBState, { where: { name: "N" } });

    if (res === undefined) return 0;

    return res.valueNumber;
  }

  async getSyncStartBlockNumber(): Promise<number> {
    const latestBlockNumber = await this.getBlockHeight() - this.chainConfig.confirmationsCollect;

    const averageBlocksPerDay = await this.getAverageBlocksPerDay();

    // todo: averageBlocksPerDay must be > 0

    this.logger.debug(`${this.chainConfig.name} avg blk per day ${averageBlocksPerDay}`);

    let blockNumber = latestBlockNumber - this.config.syncTimeDays * averageBlocksPerDay;

    const targetTime = getUnixEpochTimestamp() - this.config.syncTimeDays * this.Csec2day;

    for (let a = 0; a < 100; a++) {
      const blockTime = await this.getBlockNumberTimestamp(blockNumber);

      if (blockTime <= targetTime) {
        return blockNumber;
      }

      // if time is still in the sync period then add one more hour
      blockNumber = Math.floor(blockNumber - averageBlocksPerDay / 24);
    }

    // todo: report error

    return blockNumber;
  }



  async saveBlocksHeaders(fromBlockNumber: number, toBlockNumberInc: number) {

    try {
      // save blocks from fromBlockNumber to toBlockNumberInc
      const dbBlocks = [];
      for (let blockNumber = fromBlockNumber; blockNumber <= toBlockNumberInc; blockNumber++) {
        // todo: use fast getblock function (no details)
        const block = await this.getBlock(blockNumber);

        const dbBlock = new (this.dbBlockClass)();

        dbBlock.blockNumber = blockNumber;
        dbBlock.blockHash = block.hash;
        dbBlock.timestamp = block.unixTimestamp;

        dbBlocks.push(dbBlock);
      }

      await this.dbService.manager.save(dbBlocks);

      // await this.dbService.manager
      //   .createQueryBuilder()
      //   .update(DBBlock)
      //   .set({ confirmed: true })
      //   .where("blockNumber < :blockNumber", { blockNumber: blockNumber - this.chainConfig.confirmationsIndex })
      //   .execute();
    }
    catch (error) {
      this.logger.error2(`error ${error}`);
    }
  }


  async saveOrWaitNp1Block() {
    const Np1 = this.N + 1;

    const preparedBlocks = this.preparedBlocks.get(Np1);

    // check if N+1 with blockNp1hash is already prepared (otherwise wait for it)
    for (let preparedBlock of preparedBlocks) {
      if (preparedBlock.block.blockHash === this.blockNp1hash) {

        // save prepared N+1 block with active hash
        await this.blockSave(preparedBlock.block, preparedBlock.transactions);

        this.preparedBlocks.delete(Np1);

        return;
      }
    }

    // check if Np1 with Np1Hash is in preparation
    let exists = false;
    for (let processor of this.blockProcessorManager.blockProcessors) {
      if (processor.block.number == Np1 && processor.block.hash == this.blockNp1hash) {
        exists = true;
      }
    }

    if (!exists) {
      // PANIC
      this.logger.error2(`N+1 block not in processor`);
      return;
    }

    // wait until N+1 block is saved (blockCompleted will save it immediatelly)
    this.waitNp1 = true;
    // todo: check how to use signals in TS (instead of loop with sleep)
    while (this.waitNp1) {
      await sleepms(100);
    }
  }


  async runBlockHeaderCollecting() {
    let localN = this.N;
    let localBlockNp1hash = "";

    while (true) {
      try {
        // get chain top block
        const localT = await this.getBlockHeight();
        const blockNp1 = await this.getBlock(localN + 1) as IBlock;

        // has N+1 confirmation block
        const isNewBlock = localN < localT - this.chainConfig.confirmationsCollect;
        const isChangedNp1Hash = localBlockNp1hash !== blockNp1.hash;

        // check if N + 1 hash is the same
        if (!isNewBlock && !isChangedNp1Hash) {
          await sleep(this.config.blockCollectTimeMs);
          continue;
        }

        // save block headers N+1 ... T
        this.saveBlocksHeaders(localN + 1, localT);

        if (isNewBlock) {
          localN++;
        }

        // save block N+1 hash
        localBlockNp1hash = blockNp1.hash;

      } catch (e) {
        this.logger.error2(`Exception: ${e}`);
      }
    }
  }



  async runIndexer() {

    // wait for db to connect
    await this.waitForDBConnection();

    await this.prepareTables();

    const startBlockNumber = await this.getBlockHeight() - this.chainConfig.confirmationsCollect;

    this.N = startBlockNumber;

    // N is last completed block - confirmed and stored in DB

    if (this.config.syncEnabled) {
      // get DB last number
      const dbStartBlockNumber = await this.getDBStartBlockNumber();
      const syncStartBlockNumber = await this.getSyncStartBlockNumber();

      this.N = Math.max(dbStartBlockNumber, syncStartBlockNumber);
    }

    this.runBlockHeaderCollecting();

    while (true) {
      try {
        // get chain top block
        this.T = await this.getBlockHeight();

        // change getBlock to getBlockHeader
        const blockNp1 = await this.getBlock(this.N + 1) as IBlock;

        // has N+1 confirmation block
        const isNewBlock = this.N < this.T - this.chainConfig.confirmationsCollect;
        const isChangedNp1Hash = this.blockNp1hash !== blockNp1.hash;

        // check if N + 1 hash is the same
        if (!isNewBlock && !isChangedNp1Hash) {
          await sleep(this.config.blockCollectTimeMs);
          continue;
        }

        // save completed N+1 block or wait for it
        if (isNewBlock) {
          await this.saveOrWaitNp1Block();
        }

        // process new or changed N+1
        this.blockNp1hash = blockNp1.hash;
        this.blockProcessorManager.process(blockNp1);

      } catch (e) {
        this.logger.error2(`Exception: ${e}`);
      }
    }
  }
}


async function displayStats() {
  const period = 10000;

  const logger = getGlobalLogger();

  while (true) {
    await sleep(period);

    logger.info(
      `^Y${round((Indexer.sendCount * 1000) / period, 1)} req/sec  ${round((Indexer.txCount * 1000) / period, 1)} tx/sec (${round(
        Indexer.txCount / Indexer.sendCount,
        1
      )} tx/req)   valid ${Indexer.valid} invalid ${Indexer.invalid}`
    );
    Indexer.sendCount = 0;
    Indexer.txCount = 0;
  }
}

async function runIndexer() {
  // Reading configuration
  const fs = require("fs");
  const config: IndexerConfiguration = JSON.parse(fs.readFileSync((args as any).config).toString()) as IndexerConfiguration;

  const indexer = new Indexer(config, args["chain"]);

  displayStats();

  return await indexer.runIndexer();
}


// read .env
DotEnvExt();

// (new AttestationSpammer()).runSpammer()
runIndexer()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

