import { Managed, toBN } from "@flarenetwork/mcc";
import { exit } from "process";
import { criticalAsync } from "../indexer/indexer-utils";
import { EpochSettings } from "../utils/data-structures/EpochSettings";
import { attesterEntities } from "../utils/database/databaseEntities";
import { DatabaseService } from "../utils/database/DatabaseService";
import { getTimeMilli } from "../utils/helpers/internetTime";
import { safeCatch } from "../utils/helpers/promiseTimeout";
import { MOCK_NULL_WHEN_TESTING, round, sleepms } from "../utils/helpers/utils";
import { AttLogger, logException } from "../utils/logging/logger";
import { toSourceId } from "../verification/sources/sources";
import { Attestation } from "./Attestation";
import { AttestationData } from "./AttestationData";
import { AttestationRound } from "./AttestationRound";
import { AttesterState } from "./AttesterState";
import { BitVoteData } from "./BitVoteData";
import { AttestationClientConfig } from "./configs/AttestationClientConfig";
import { sourceAndTypeSupported } from "./configs/GlobalAttestationConfig";
import { SourceLimiterConfig } from "./configs/SourceLimiterConfig";
import { FlareConnection } from "./FlareConnection";
import { GlobalConfigManager } from "./GlobalConfigManager";
import { SourceRouter } from "./source/SourceRouter";
import { AttestationStatus } from "./types/AttestationStatus";

/**
 * Manages attestation rounds (AttestationRound). This includes initiating them, scheduling actions and passing attestations to 
 * attestation rounds for further processing.
 */
@Managed()
export class AttestationRoundManager {
  logger: AttLogger;
  sourceRouter: SourceRouter;
  globalConfigManager: GlobalConfigManager;
  dbServiceAttester: DatabaseService;

  attesterState: AttesterState;

  startRoundId: number;
  private _activeRoundId: number | undefined = undefined;

  rounds = new Map<number, AttestationRound>();
  attestationClientConfig: AttestationClientConfig;
  flareConnection: FlareConnection;

  private _initialized = false;

  // debugCallbacks: AttestationClientDebugCallbacks;

  constructor(
    config: AttestationClientConfig,
    logger: AttLogger,
    flareConnection: FlareConnection,
    sourceRouter?: SourceRouter
  ) {
    this.attestationClientConfig = config;
    this.logger = logger;
    this.flareConnection = flareConnection;

    this.sourceRouter = sourceRouter ?? new SourceRouter(this);
    this.globalConfigManager = new GlobalConfigManager(this);
  }

  get activeRoundId(): number {
    if (this._activeRoundId === undefined) {
      throw new Error("activeRoundId not defined")
    }
    return this._activeRoundId;
  }

  set activeRoundId(value: number) {
    this._activeRoundId = value;
  }

  get epochSettings(): EpochSettings {
    if (!this.flareConnection.epochSettings) {
      throw new Error("EpochSettings not yet initialized");
    }
    return this.flareConnection.epochSettings;
  }

  get label() {
    let label = ""
    if (this.attestationClientConfig.label != "none") {
      label = `[${this.attestationClientConfig.label}]`;
    }
    return label;
  }

  /**
   * Initializes attestation round manager
   */
  public async initialize(): Promise<void> {
    if (this._initialized) {
      throw new Error("AttestationRoundManager can be initialized only once");
    }
    // initialize activeRoundId for the first time, before first load of DAC, routings
    this.activeRoundId = this.epochSettings.getEpochIdForTime(toBN(getTimeMilli())).toNumber();

    // Load DAC configs
    await this.globalConfigManager.initialize();

    this.dbServiceAttester = new DatabaseService(
      this.logger,
      {
      ...this.attestationClientConfig.attesterDatabase,
      entities: attesterEntities(),
        synchronize: true,
      },
      "attester"
    );
    await this.dbServiceAttester.connect();

    // update active round again since waiting for DB connection can take time
    this.activeRoundId = this.epochSettings.getEpochIdForTime(toBN(getTimeMilli())).toNumber();
    this.startRoundId = this.activeRoundId;

    this.attesterState = new AttesterState(this.dbServiceAttester);

    // eslint-disable-next-line    
    criticalAsync("startRoundUpdate", async () => {
      await this.startRoundUpdate();
    });

    this._initialized = true;
  }

  /**
   * Additional mechanism to update round manager when there are no requests
   */
  async startRoundUpdate(): Promise<void> {
    while (true) {
      try {
        const epochId: number = this.epochSettings.getEpochIdForTime(toBN(getTimeMilli())).toNumber();
        this.activeRoundId = epochId;

        const activeRound = this.getRoundOrCreateIt(epochId);
        await activeRound.initialize();

        await this.attesterState.saveRoundComment(activeRound, activeRound.attestationsProcessed);
      } catch (error) {
        logException(error, `${this.label}startRoundUpdate`);
      }

      await sleepms(5000);
    }
  }

  /**
   * Gets the source handler configuration for a given @param name
   * @param name 
   * @returns 
   */
  getSourceLimiterConfig(name: string): SourceLimiterConfig {
    return this.globalConfigManager.getSourceLimiterConfig(toSourceId(name), this.activeRoundId);
  }

  public onLastFlareNetworkTimestamp(timestamp: number) {
    let bufferNumber = this.epochSettings.getEpochIdForBitVoteTimeSec(timestamp);

    // undefined returned if we are out of bit vote window - we are in the commit part
    if (bufferNumber === undefined) {
      bufferNumber = this.epochSettings.getEpochIdForTimeSec(timestamp);
      let roundId = bufferNumber - 1;
      let round = this.rounds.get(roundId);
      if (round) {
        round.closeBitVoting();
      }
    }
  }

  public onBitVoteEvent(bitVoteData: BitVoteData) {
    let bufferNumber = this.epochSettings.getEpochIdForBitVoteTimeSec(bitVoteData.timestamp);
    if (bufferNumber !== undefined) {
      let roundId = bufferNumber - 1;
      if (bitVoteData.roundCheck(roundId)) {
        let round = this.rounds.get(roundId);
        if (round) {
          round.registerBitVote(bitVoteData);
        }
      }
    }
  }

  /**
   * Schedules a callback for delayed time
   * @param label 
   * @param callback 
   * @param after - delayed time in ms
   */
  schedule(label: string, callback: () => void, after: number) {
    setTimeout(() => {
      safeCatch(label, callback);
    }, after);
  }

  private initRoundSampler(activeRound: AttestationRound, roundStartTime: number, windowDuration: number, roundCommitStartTime: number) {
    const intervalId = setInterval(
      () => {
      const now = getTimeMilli();
      if (now > roundCommitStartTime) {
        clearInterval(intervalId);
      }
      const eta = (windowDuration - (now - roundStartTime)) / 1000;
      if (eta >= 0) {
        this.logger.debug(
            `${this.label}!round: ^Y#${activeRound.roundId}^^ ETA: ${round(eta, 0)} sec ^Wattestation requests: ${activeRound.attestationsProcessed}/${
              activeRound.attestations.length
          }  `
        );
      }
      },
      process.env.TEST_SAMPLING_REQUEST_INTERVAL ? parseInt(process.env.TEST_SAMPLING_REQUEST_INTERVAL, 10) : 5000
    );
  }

  /**
   * Gets the attestation round for a given @param epochId.
   * If the attestation round does not exist, it gets created, initialized and registered.
   * @param roundId 
   * @returns attestation round for given @param roundId
   */
  getRoundOrCreateIt(roundId: number): AttestationRound {
    const now = getTimeMilli();
    let activeRound = this.rounds.get(roundId);

    if (activeRound) {
      return activeRound;
    }

    // check if DAC exists for this round id
    const globalConfig = this.globalConfigManager.getConfig(roundId);

    if (!globalConfig) {
      this.logger.error(`${this.label}${roundId}: critical error, DAC config for round id not defined`);
      exit(1);
      return MOCK_NULL_WHEN_TESTING;
    }

    // check if verifier router exists for this round id. 
    const verifier = this.globalConfigManager.getVerifierRouter(roundId);

    // If no verifier, round cannot be evaluated - critical error.
    if (!verifier) {
      this.logger.error(`${this.label}${roundId}: critical error, verifier route for round id not defined`);
      exit(1);
      return MOCK_NULL_WHEN_TESTING;
    }

    // Update sources to the latest global configs and verifier router configs
    this.sourceRouter.initializeSources(roundId);

    // create new round
    activeRound = new AttestationRound(
      roundId,
      globalConfig,
      this.epochSettings,
      this.logger,
      this.flareConnection,
      this.attesterState,
      this.sourceRouter,
      this.attestationClientConfig
    );

    this.initRoundSampler(activeRound, activeRound.roundStartTimeMs, activeRound.windowDurationMs, activeRound.roundCommitStartTimeMs);

    // Schedule callbacks
    this.logger.info(`${this.label}^w^Rcollect phase started^^ round ^Y#${roundId}^^`);

    // trigger start choose phase
    this.schedule(`${this.label}schedule:startChoosePhase`, async () => await activeRound!.startChoosePhase(), activeRound.roundChooseStartTimeMs - now);

    // trigger sending bit vote result
    this.schedule(`${this.label}schedule:bitVote`, async () => await activeRound!.bitVote(), activeRound.roundCommitStartTimeMs + (this.attestationClientConfig.bitVoteTimeSec * 1000) - now);

    // trigger forced closing of bit voting and vote count
    this.schedule(`${this.label}schedule:closeBitVoting`, async () => await activeRound!.closeBitVoting(), activeRound.roundForceCloseBitVotingTimeMs - now);

    // trigger start commit phase
    this.schedule(`${this.label}schedule:startCommitPhase`, async () => await activeRound!.startCommitPhase(), activeRound.roundCommitStartTimeMs - now);

    // trigger start commit epoch submit
    this.schedule(`${this.label}schedule:startCommitSubmit`, () => activeRound!.startCommitSubmit(), activeRound.roundCommitStartTimeMs - now + 1000);

    // trigger start reveal epoch
    this.schedule(`${this.label}schedule:startRevealEpoch`, () => activeRound!.startRevealPhase(), activeRound.roundRevealStartTimeMs - now);

    // trigger reveal
    this.schedule(`${this.label}schedule:reveal`, () => activeRound!.reveal(), activeRound.roundCompleteTimeMs + this.attestationClientConfig.commitTimeSec * 1000 - now);

    // trigger end of reveal epoch, cycle is completed at this point
    this.schedule(`${this.label}schedule:completed`, () => activeRound!.completed(), activeRound.roundCompleteTimeMs - now);

    this.rounds.set(roundId, activeRound);
    this.cleanup();

    // link rounds
    const prevRound = this.rounds.get(roundId - 1);
    if (prevRound) {
      activeRound.prevRound = prevRound;
      prevRound.nextRound = activeRound;
    } else {
      // trigger first commit
      this.schedule(`${this.label}schedule:firstCommit`, () => activeRound!.firstCommit(), activeRound.roundRevealStartTimeMs + this.attestationClientConfig.commitTimeSec * 1000 - now);
    }

    return activeRound;
  }

  /**
   * Accepts the attestation request event.
   * Creates an attestation from attestation data and adds it to the active round
   * @param attestationData 
   * @returns 
   */
  public async onAttestationRequest(attestationData: AttestationData) {
    const epochId: number = this.epochSettings.getEpochIdForTime(attestationData.timeStamp.mul(toBN(1000))).toNumber();

    this.activeRoundId = this.epochSettings.getEpochIdForTime(toBN(getTimeMilli())).toNumber();

    if (epochId < this.startRoundId) {
      this.logger.debug(`${this.label}epoch too low ^Y#${epochId}^^`);
      return;
    }

    const activeRound = this.getRoundOrCreateIt(epochId);
    await activeRound.initialize();

    // create, check and add attestation. If attestation is not ok, status is set to 'invalid'
    const attestation = await this.createAttestation(epochId, attestationData);

    // attestation is added to the list, if non-duplicate. Invalid attestations are markd as processed
    activeRound.addAttestation(attestation);

    await this.attesterState.saveRoundComment(activeRound, activeRound.attestationsProcessed);
  }

  cleanup() {
    const epochId = this.epochSettings.getCurrentEpochId().toNumber();

    // clear old epochs
    if (this.rounds.has(epochId - 10)) {
      this.rounds.delete(epochId - 10);
    }
  }

  /**
   * Creates attestation from the round and data.
   * If no verifier router exist for the 
   * @param roundId
   * @param data 
   * @returns 
   */
  createAttestation(roundId: number, data: AttestationData): Attestation {
    const attestation = new Attestation(roundId, data);

    const config = this.globalConfigManager.getConfig(roundId);
    const verifier = this.globalConfigManager.getVerifierRouter(roundId);
    if (!config || !verifier) {
      // this should not happen
      attestation.status = AttestationStatus.failed;
      this.logger.error(`${this.label}Assert: both global config and verifier router for round should exist. Critical error`);
      process.exit(1);
    }
    const attestationSupported = sourceAndTypeSupported(config, data.sourceId, data.type);
    if (!attestationSupported || !verifier.isSupported(data.sourceId, data.type)) {
      attestation.status = AttestationStatus.failed;
      return attestation;
    }
    return attestation;
  }
}
