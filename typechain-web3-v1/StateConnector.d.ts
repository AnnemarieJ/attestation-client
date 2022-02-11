/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import BN from "bn.js";
import { ContractOptions } from "web3-eth-contract";
import { EventLog } from "web3-core";
import { EventEmitter } from "events";
import {
  Callback,
  PayableTransactionObject,
  NonPayableTransactionObject,
  BlockType,
  ContractEventLog,
  BaseContract,
} from "./types";

interface EventOptions {
  filter?: object;
  fromBlock?: BlockType;
  topics?: string[];
}

export type AttestationRequest = ContractEventLog<{
  timestamp: string;
  sender: string;
  data: string;
  0: string;
  1: string;
  2: string;
}>;

export interface StateConnector extends BaseContract {
  constructor(
    jsonInterface: any[],
    address?: string,
    options?: ContractOptions
  ): StateConnector;
  clone(): StateConnector;
  methods: {
    BUFFER_TIMESTAMP_OFFSET(): NonPayableTransactionObject<string>;

    BUFFER_WINDOW(): NonPayableTransactionObject<string>;

    SIGNAL_COINBASE(): NonPayableTransactionObject<string>;

    TOTAL_STORED_BUFFERS(): NonPayableTransactionObject<string>;

    TOTAL_STORED_PROOFS(): NonPayableTransactionObject<string>;

    buffers(arg0: string): NonPayableTransactionObject<string>;

    finaliseRound(
      bufferNumber: number | string | BN,
      merkleHash: string | number[]
    ): NonPayableTransactionObject<void>;

    getAttestation(
      bufferNumber: number | string | BN
    ): NonPayableTransactionObject<string>;

    merkleRoots(
      arg0: number | string | BN
    ): NonPayableTransactionObject<string>;

    requestAttestations(
      data: string | number[]
    ): NonPayableTransactionObject<void>;

    submitAttestation(
      bufferNumber: number | string | BN,
      maskedMerkleHash: string | number[],
      committedRandom: string | number[],
      revealedRandom: string | number[]
    ): NonPayableTransactionObject<boolean>;

    totalBuffers(): NonPayableTransactionObject<string>;
  };
  events: {
    AttestationRequest(cb?: Callback<AttestationRequest>): EventEmitter;
    AttestationRequest(
      options?: EventOptions,
      cb?: Callback<AttestationRequest>
    ): EventEmitter;

    allEvents(options?: EventOptions, cb?: Callback<EventLog>): EventEmitter;
  };

  once(event: "AttestationRequest", cb: Callback<AttestationRequest>): void;
  once(
    event: "AttestationRequest",
    options: EventOptions,
    cb: Callback<AttestationRequest>
  ): void;
}
