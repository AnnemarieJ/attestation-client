import Web3 from "web3";
import { Logger } from "winston";
import { getWeb3, getWeb3Contract, sleepms } from "./utils";

export class Web3BlockCollector {
  logger: Logger;

  web3: Web3;

  startingBlockNumber: number | undefined;
  currentBlockNumber: number = 0;

  constructor(logger: Logger, url: string, contractAddress: string, contractName: string, startBlock: number | undefined, action: any) {
    this.logger = logger;

    this.web3 = getWeb3(url, this.logger);

    this.procesEvents(contractAddress, contractName, startBlock, action);
  }

  // https://web3js.readthedocs.io/en/v1.2.11/web3-eth-contract.html?highlight=getPastEvents#contract-events-return
  eventComparator(a: any, b: any): number {
    if (a.blockNumber < b.blockNumber) return -1;
    if (a.blockNumber > b.blockNumber) return 1;

    if (a.logIndex > a.logIndex) return -1;
    if (a.logIndex < b.logIndex) return 1;

    return 0;
  }

  async procesEvents(contractAddress: string, contractName: string, startBlock: number | undefined, action: any) {
    // wait until new block is set
    this.logger.info(`waiting for network connection...`);
    const blockHeight = await this.web3.eth.getBlockNumber();
    this.startingBlockNumber = startBlock ? startBlock : blockHeight;

    const stateConnectorContract = await getWeb3Contract(this.web3, contractAddress, contractName);
    let processBlock: number = this.startingBlockNumber;

    this.logger.info(`^Rnetwork event processing started ^Y${this.startingBlockNumber} (height ${blockHeight})`);

    while (true) {
      this.currentBlockNumber = await this.web3.eth.getBlockNumber();
      // wait for new block
      if (processBlock >= this.currentBlockNumber + 1) {
        await sleepms(100);
        continue;
      }

      // process new block
      const events = await stateConnectorContract.getPastEvents("allEvents", { fromBlock: processBlock, toBlock: processBlock });

      //this.logger.debug(`!new block ${processBlock} with ${events.length} event(s)`);

      // order events by: blockNumber, log_index
      events.sort((a: any, b: any) => {
        return this.eventComparator(a, b);
      });

      for (const event of events) {
        action(event);
      }

      processBlock++;
    }
  }
}
