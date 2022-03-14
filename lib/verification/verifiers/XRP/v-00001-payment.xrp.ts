//////////////////////////////////////////////////////////////
// This file is auto generated. You may edit it only in the 
// marked section between //-$$$<start> and //-$$$<end>.
// You may also import custom imports needed for the code
// in the custom section, which should be placed immediately 
// in the usual import section (below this comment)
//////////////////////////////////////////////////////////////

import { ARPayment, Attestation, BN, DHPayment, hashPayment, IndexedQueryManager, parseRequestBytes, randSol, RPCInterface, TDEF_payment, Verification, VerificationStatus, Web3 } from "./0imports";
import { toBN } from "flare-mcc/dist/utils/utils";
import { Payment, TransactionMetadata, TxResponse } from "xrpl";
import { numberLikeToNumber } from "../../attestation-types/attestation-types-helpers";

const web3 = new Web3();

export async function verifyPaymentXRP(client: RPCInterface, attestation: Attestation, indexer: IndexedQueryManager, recheck = false) {
   let request = parseRequestBytes(attestation.data.request, TDEF_payment) as ARPayment;
   let roundId = attestation.round.roundId;

   //-$$$<start> of the custom code section. Do not change this comment. XXX

   // TODO: pass 
   let blockNumber = numberLikeToNumber(request.blockNumber);
   let result = await indexer.checkTransactionExistence({
      txId: request.id,
      blockNumber: numberLikeToNumber(request.blockNumber),
      dataAvailability: request.dataAvailabilityProof,
      roundId: roundId,
      type: recheck ? 'RECHECK' : 'FIRST_CHECK'
   })

   if (result.status === 'RECHECK') {
      return {
         status: VerificationStatus.RECHECK_LATER
      } as Verification<DHPayment>;
   }

   if (result.status === 'NOT_EXIST') {
      return {
         status: VerificationStatus.NON_EXISTENT_TRANSACTION
      }
   }

   let transaction = JSON.parse(result.transaction.response) as TxResponse;

   let metaData: TransactionMetadata = transaction.result.meta || (transaction.result as any).metaData;
   let fee = toBN(transaction.result.Fee!);

   if (recheck) {
      let confirmationBlockIndex = blockNumber + 1// request.confirmations; TODO
      let confirmationBlock = await indexer.queryBlock({
         blockNumber: confirmationBlockIndex,
         roundId
      });
      if (!confirmationBlock) {
         return {
            status: VerificationStatus.NOT_CONFIRMED
         }
      }
      if (confirmationBlock.blockHash != request.dataAvailabilityProof) {
         return {
            status: VerificationStatus.WRONG_DATA_AVAILABILITY_PROOF
         }
      }
   }

   if (transaction.result.TransactionType != "Payment") {
      return {
         status: VerificationStatus.NOT_PAYMENT
      }
   }

   // Transaction is Payment
   let delivered = toBN(metaData.delivered_amount as string); // XRP in drops

   let status = this.client.getTransactionStatus(transaction);

   let payment = transaction.result as Payment;
   let response = {
      blockNumber: toBN(blockNumber),
      blockTimestamp: toBN(result.transaction.timestamp),
      transactionHash: result.transaction.transactionId,
      utxo: toBN(0),
      sourceAddress: transaction.result.Account,
      receivingAddress: payment.Destination,
      paymentReference: toBN(0),  // TODO
      spentAmount: toBN(payment.Amount as any).add(fee),
      receivedAmount: delivered,
      oneToOne: true,
      status: toBN(status)
   } as DHPayment;

   //-$$$<end> of the custom section. Do not change this comment.



   let hash = hashPayment(request, response);

   return {
      hash,
      response,
      status: VerificationStatus.OK
   } as Verification<DHPayment>;
}   
