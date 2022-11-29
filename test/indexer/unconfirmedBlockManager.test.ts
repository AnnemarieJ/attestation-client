import { DBBlockDOGE } from "../../lib/entity/indexer/dbBlock";
import { UnconfirmedBlockManager } from "../../lib/indexer/UnconfirmedBlockManager";
import { DatabaseService, DatabaseSourceOptions } from "../../lib/utils/databaseService";
import { getGlobalLogger } from "../../lib/utils/logger";

const chai = require("chai");
const chaiaspromised = require("chai-as-promised");
chai.use(chaiaspromised);
const expect = chai.expect;
const assert = chai.assert;

describe("UnconfirmedBlockManager", function () {
  const databaseConnectOptions = new DatabaseSourceOptions();
  databaseConnectOptions.database = process.env.DATABASE_NAME2;
  databaseConnectOptions.username = process.env.DATABASE_USERNAME;
  databaseConnectOptions.password = process.env.DATBASE_PASS;
  const dataService = new DatabaseService(getGlobalLogger(), databaseConnectOptions);

  let unconfirmedBlockManager = new UnconfirmedBlockManager(dataService, DBBlockDOGE, 7);

  before(async () => {
    if (!dataService.dataSource.isInitialized) {
      await dataService.init();
    }

    //generate test table
    const tableName = "doge_block";
    await dataService.connection.query(`TRUNCATE ${tableName};`);
    for (let j = 5; j < 16; j++) {
      const entity = new DBBlockDOGE();
      entity.blockNumber = j;
      entity.blockHash = `${j}`;
      entity.timestamp = 10 + j;
      entity.confirmed = false;
      entity.transactions = 10;
      entity.previousBlockHash = `${j - 1}`;
      entity.numberOfConfirmations = 16 - j;
      await dataService.manager.save(entity);
    }
  });

  it("should construct", function () {
    expect(unconfirmedBlockManager).to.not.be.undefined;
  });

  it("should initalize", async function () {
    await unconfirmedBlockManager.initialize();
    expect(unconfirmedBlockManager.blockHashToEntity.size).to.eq(8);
  });

  it("should add new block", function () {
    const entity = new DBBlockDOGE();
    entity.blockNumber = 16;
    entity.blockHash = "16";
    entity.timestamp = 26;
    entity.confirmed = false;
    entity.transactions = 10;
    entity.previousBlockHash = "15";
    // entity.numberOfConfirmations = 0;

    unconfirmedBlockManager.addNewBlock(entity);
    expect(unconfirmedBlockManager.blockHashToEntity.size).to.eq(9);
    expect(unconfirmedBlockManager.changed.size).to.eq(9);
  });

  it("should add new block", function () {
    const entity = new DBBlockDOGE();
    entity.blockNumber = 17;
    entity.blockHash = "17";
    entity.timestamp = 26;
    entity.confirmed = true;
    entity.transactions = 10;
    entity.previousBlockHash = "16";
    // entity.numberOfConfirmations = 0;

    unconfirmedBlockManager.addNewBlock(entity);
    expect(unconfirmedBlockManager.blockHashToEntity.get("16").numberOfConfirmations).to.eq(1);
    expect(unconfirmedBlockManager.blockHashToEntity.size).to.eq(10);
    expect(unconfirmedBlockManager.changed.size).to.eq(10);
  });

  it("should not add new block", function () {
    const entity = new DBBlockDOGE();
    entity.blockNumber = 17;
    entity.blockHash = "9";
    entity.timestamp = 26;
    entity.confirmed = true;
    entity.transactions = 10;
    entity.previousBlockHash = "16";
    // entity.numberOfConfirmations = 0;

    unconfirmedBlockManager.addNewBlock(entity);
    expect(unconfirmedBlockManager.blockHashToEntity.get("16").numberOfConfirmations).to.eq(1);
    expect(unconfirmedBlockManager.blockHashToEntity.size).to.eq(10);
    expect(unconfirmedBlockManager.changed.size).to.eq(10);
  });

  it("should get changed blocks", function () {
    let res = unconfirmedBlockManager.getChangedBlocks();
    expect(res.length).to.eq(10);
  });
});
