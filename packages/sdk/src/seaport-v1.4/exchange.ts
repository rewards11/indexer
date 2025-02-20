import { defaultAbiCoder } from "@ethersproject/abi";
import { Provider, TransactionResponse } from "@ethersproject/abstract-provider";
import { Signer, TypedDataSigner } from "@ethersproject/abstract-signer";
import { BigNumberish } from "@ethersproject/bignumber";
import { hexConcat } from "@ethersproject/bytes";
import { AddressZero, HashZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { _TypedDataEncoder } from "@ethersproject/hash";
import { keccak256 } from "@ethersproject/keccak256";
import { keccak256 as solidityKeccak256 } from "@ethersproject/solidity";
import axios from "axios";
import { MerkleTree } from "merkletreejs";

import * as Addresses from "./addresses";
import { BaseOrderInfo } from "./builders/base";
import { EIP712_DOMAIN, ORDER_EIP712_TYPES, Order } from "./order";
import * as Types from "./types";
import * as CommonAddresses from "../common/addresses";
import { TxData, bn, generateSourceBytes, lc, n, s } from "../utils";

import ExchangeAbi from "./abis/Exchange.json";

export class Exchange {
  public chainId: number;
  public contract: Contract;

  constructor(chainId: number) {
    this.chainId = chainId;
    this.contract = new Contract(Addresses.Exchange[this.chainId], ExchangeAbi);
  }

  // --- Fill order ---

  public async fillOrder(
    taker: Signer,
    order: Order,
    matchParams: Types.MatchParams,
    options?: {
      recipient?: string;
      conduitKey?: string;
      feesOnTop?: {
        amount: string;
        recipient: BigNumberish;
      }[];
      source?: string;
    }
  ): Promise<TransactionResponse> {
    const tx = await this.fillOrderTx(await taker.getAddress(), order, matchParams, options);
    return taker.sendTransaction(tx);
  }

  public async fillOrderTx(
    taker: string,
    order: Order,
    matchParams: Types.MatchParams,
    options?: {
      recipient?: string;
      conduitKey?: string;
      feesOnTop?: {
        amount: string;
        recipient: BigNumberish;
      }[];
      source?: string;
    }
  ): Promise<TxData> {
    const recipient = options?.recipient ?? AddressZero;
    const conduitKey = options?.conduitKey ?? HashZero;
    const feesOnTop = options?.feesOnTop ?? [];

    let info = order.getInfo();
    if (!info) {
      throw new Error("Could not get order info");
    }

    if (info.side === "sell") {
      if (
        // Order is not private
        recipient === AddressZero &&
        // Order is single quantity
        info.amount === "1" &&
        // Order has no criteria
        !matchParams.criteriaResolvers &&
        // Order requires no extra data
        !this.requiresExtraData(order)
      ) {
        info = info as BaseOrderInfo;

        // Use "basic" fulfillment
        return {
          from: taker,
          to: this.contract.address,
          data:
            this.contract.interface.encodeFunctionData("fulfillBasicOrder", [
              {
                considerationToken: info.paymentToken,
                considerationIdentifier: "0",
                considerationAmount: info.price,
                offerer: order.params.offerer,
                zone: order.params.zone,
                offerToken: info.contract,
                offerIdentifier: info.tokenId,
                offerAmount: info.amount,
                basicOrderType:
                  (info.tokenKind === "erc721"
                    ? info.paymentToken === CommonAddresses.Eth[this.chainId]
                      ? Types.BasicOrderType.ETH_TO_ERC721_FULL_OPEN
                      : Types.BasicOrderType.ERC20_TO_ERC721_FULL_OPEN
                    : info.paymentToken === CommonAddresses.Eth[this.chainId]
                    ? Types.BasicOrderType.ETH_TO_ERC1155_FULL_OPEN
                    : Types.BasicOrderType.ERC20_TO_ERC1155_FULL_OPEN) + order.params.orderType,
                startTime: order.params.startTime,
                endTime: order.params.endTime,
                zoneHash: order.params.zoneHash,
                salt: order.params.salt,
                offererConduitKey: order.params.conduitKey,
                fulfillerConduitKey: conduitKey,
                totalOriginalAdditionalRecipients: order.params.consideration.length - 1,
                additionalRecipients: [
                  ...order.params.consideration.slice(1).map(({ startAmount, recipient }) => ({
                    amount: startAmount,
                    recipient,
                  })),
                  ...feesOnTop,
                ],
                signature: order.params.signature!,
              },
            ]) + generateSourceBytes(options?.source),
          value:
            info.paymentToken === CommonAddresses.Eth[this.chainId]
              ? bn(order.getMatchingPrice())
                  .mul(matchParams.amount || "1")
                  .div(info.amount)
                  .toHexString()
              : undefined,
        };
      } else {
        // Use "advanced" fullfillment
        return {
          from: taker,
          to: this.contract.address,
          data:
            this.contract.interface.encodeFunctionData("fulfillAdvancedOrder", [
              {
                parameters: {
                  ...order.params,
                  totalOriginalConsiderationItems: order.params.consideration.length,
                },
                numerator: matchParams.amount || "1",
                denominator: info.amount,
                signature: order.params.signature!,
                extraData: await this.getExtraData(order, matchParams),
              },
              matchParams.criteriaResolvers || [],
              conduitKey,
              recipient,
            ]) + generateSourceBytes(options?.source),
          value:
            info.paymentToken === CommonAddresses.Eth[this.chainId]
              ? bn(order.getMatchingPrice())
                  .mul(matchParams.amount || "1")
                  .div(info.amount)
                  .toHexString()
              : undefined,
        };
      }
    } else {
      if (
        // Order is not private
        recipient === AddressZero &&
        // Order is single quantity
        info.amount === "1" &&
        // Order has no criteria
        !matchParams.criteriaResolvers &&
        // Order requires no extra data
        !this.requiresExtraData(order)
      ) {
        info = info as BaseOrderInfo;

        // Use "basic" fulfillment
        return {
          from: taker,
          to: this.contract.address,
          data:
            this.contract.interface.encodeFunctionData("fulfillBasicOrder", [
              {
                considerationToken: info.contract,
                considerationIdentifier: info.tokenId,
                considerationAmount: info.amount,
                offerer: order.params.offerer,
                zone: order.params.zone,
                offerToken: info.paymentToken,
                offerIdentifier: "0",
                offerAmount: info.price,
                basicOrderType:
                  (info.tokenKind === "erc721"
                    ? Types.BasicOrderType.ERC721_TO_ERC20_FULL_OPEN
                    : Types.BasicOrderType.ERC1155_TO_ERC20_FULL_OPEN) + order.params.orderType,
                startTime: order.params.startTime,
                endTime: order.params.endTime,
                zoneHash: order.params.zoneHash,
                salt: order.params.salt,
                offererConduitKey: order.params.conduitKey,
                fulfillerConduitKey: conduitKey,
                totalOriginalAdditionalRecipients: order.params.consideration.length - 1,
                additionalRecipients: [
                  ...order.params.consideration.slice(1).map(({ startAmount, recipient }) => ({
                    amount: startAmount,
                    recipient,
                  })),
                  ...feesOnTop,
                ],
                signature: order.params.signature!,
              },
            ]) + generateSourceBytes(options?.source),
        };
      } else {
        // Use "advanced" fulfillment
        return {
          from: taker,
          to: this.contract.address,
          data:
            this.contract.interface.encodeFunctionData("fulfillAdvancedOrder", [
              {
                parameters: {
                  ...order.params,
                  totalOriginalConsiderationItems: order.params.consideration.length,
                },
                numerator: matchParams.amount || "1",
                denominator: info.amount,
                signature: order.params.signature!,
                extraData: await this.getExtraData(order, matchParams),
              },
              matchParams.criteriaResolvers || [],
              conduitKey,
              recipient,
            ]) + generateSourceBytes(options?.source),
        };
      }
    }
  }

  // --- Batch fill orders ---

  public async fillOrders(
    taker: Signer,
    orders: Order[],
    matchParams: Types.MatchParams[],
    options?: {
      recipient?: string;
      conduitKey?: string;
      source?: string;
      maxOrdersToFulfill?: number;
    }
  ): Promise<TransactionResponse> {
    const tx = await this.fillOrdersTx(await taker.getAddress(), orders, matchParams, options);
    return taker.sendTransaction(tx);
  }

  public async fillOrdersTx(
    taker: string,
    orders: Order[],
    matchParams: Types.MatchParams[],
    options?: {
      recipient?: string;
      conduitKey?: string;
      source?: string;
      maxOrdersToFulfill?: number;
    }
  ): Promise<TxData> {
    const recipient = options?.recipient ?? AddressZero;
    const conduitKey = options?.conduitKey ?? HashZero;

    return {
      from: taker,
      to: this.contract.address,
      data:
        this.contract.interface.encodeFunctionData("fulfillAvailableAdvancedOrders", [
          await Promise.all(
            orders.map(async (order, i) => ({
              parameters: {
                ...order.params,
                totalOriginalConsiderationItems: order.params.consideration.length,
              },
              numerator: matchParams[i].amount || "1",
              denominator: order.getInfo()!.amount,
              signature: order.params.signature!,
              extraData: await this.getExtraData(order, matchParams[i]),
            }))
          ),
          matchParams
            .map((m, i) =>
              (m.criteriaResolvers ?? []).map((resolver) => ({
                ...resolver,
                orderIndex: i,
              }))
            )
            .flat(),
          // TODO: Optimize fulfillment components
          orders
            .map((order, i) =>
              order.params.offer.map((_, j) => ({
                orderIndex: i,
                itemIndex: j,
              }))
            )
            .flat()
            .map((x) => [x]),
          orders
            .map((order, i) =>
              order.params.consideration.map((_, j) => ({
                orderIndex: i,
                itemIndex: j,
              }))
            )
            .flat()
            .map((x) => [x]),
          conduitKey,
          recipient,
          options?.maxOrdersToFulfill ?? 255,
        ]) + generateSourceBytes(options?.source),
      value: bn(
        orders
          .filter((order) => {
            const info = order.getInfo();
            return (
              info &&
              info.side === "sell" &&
              info.paymentToken === CommonAddresses.Eth[this.chainId]
            );
          })
          .map((order, i) =>
            bn(order.getMatchingPrice())
              .mul(matchParams[i].amount || "1")
              .div(order.getInfo()!.amount)
          )
          .reduce((a, b) => bn(a).add(b), bn(0))
      ).toHexString(),
    };
  }

  // --- Cancel order ---

  public async cancelOrder(maker: Signer, order: Order): Promise<TransactionResponse> {
    const tx = this.cancelOrderTx(await maker.getAddress(), order);
    return maker.sendTransaction(tx);
  }

  public cancelOrderTx(maker: string, order: Order): TxData {
    return {
      from: maker,
      to: this.contract.address,
      data: this.contract.interface.encodeFunctionData("cancel", [[order.params]]),
    };
  }

  // --- Bulk sign orders ---

  public getBulkSignatureDataWithProofs(orders: Order[]) {
    const height = Math.max(Math.ceil(Math.log2(orders.length)), 1);
    const size = Math.pow(2, height);

    const types = { ...ORDER_EIP712_TYPES };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (types as any).BulkOrder = [{ name: "tree", type: `OrderComponents${`[2]`.repeat(height)}` }];
    const encoder = _TypedDataEncoder.from(types);

    const hashElement = (element: Types.OrderComponents) =>
      encoder.hashStruct("OrderComponents", element);

    const elements = orders.map((o) => o.params);
    const leaves = elements.map((e) => hashElement(e));

    const defaultElement: Types.OrderComponents = {
      offerer: AddressZero,
      zone: AddressZero,
      offer: [],
      consideration: [],
      orderType: 0,
      startTime: 0,
      endTime: 0,
      zoneHash: HashZero,
      salt: "0",
      conduitKey: HashZero,
      counter: "0",
    };
    const defaultLeaf = hashElement(defaultElement);

    // Ensure the tree is complete
    while (elements.length < size) {
      elements.push(defaultElement);
      leaves.push(defaultLeaf);
    }

    const hexToBuffer = (value: string) => Buffer.from(value.slice(2), "hex");
    const bufferKeccak = (value: string) => hexToBuffer(keccak256(value));

    const tree = new MerkleTree(leaves.map(hexToBuffer), bufferKeccak, {
      complete: true,
      sort: false,
      hashLeaves: false,
      fillDefaultHash: hexToBuffer(defaultLeaf),
    });

    let chunks: object[] = [...elements];
    while (chunks.length > 2) {
      const newSize = Math.ceil(chunks.length / 2);
      chunks = Array(newSize)
        .fill(0)
        .map((_, i) => chunks.slice(i * 2, (i + 1) * 2));
    }

    return {
      signatureData: {
        signatureKind: "eip712",
        domain: EIP712_DOMAIN(this.chainId),
        types: types,
        value: { tree: chunks },
      },
      proofs: orders.map((_, i) => tree.getHexProof(leaves[i], i)),
    };
  }

  public async bulkSign(signer: TypedDataSigner, orders: Order[]) {
    const { signatureData, proofs } = this.getBulkSignatureDataWithProofs(orders);

    const signature = await signer._signTypedData(
      signatureData.domain,
      signatureData.types,
      signatureData.value
    );

    orders.forEach((order, i) => {
      order.params.signature = this.encodeBulkOrderProofAndSignature(i, proofs[i], signature);
    });
  }

  public encodeBulkOrderProofAndSignature = (
    orderIndex: number,
    merkleProof: string[],
    signature: string
  ) => {
    return hexConcat([
      signature,
      `0x${orderIndex.toString(16).padStart(6, "0")}`,
      defaultAbiCoder.encode([`uint256[${merkleProof.length}]`], [merkleProof]),
    ]);
  };

  // --- Get extra data ---

  public requiresExtraData(order: Order): boolean {
    if (order.params.zone === Addresses.CancellationZone[this.chainId]) {
      return true;
    }
    return false;
  }

  public async getExtraData(order: Order, matchParams: Types.MatchParams): Promise<string> {
    switch (order.params.zone) {
      case Addresses.CancellationZone[this.chainId]: {
        return axios
          .post(
            `https://seaport-oracle-${
              this.chainId === 1 ? "mainnet" : "goerli"
            }.up.railway.app/api/signatures`,
            {
              orders: [
                {
                  chainId: this.chainId,
                  orderParameters: order.params,
                  fulfiller: AddressZero,
                  marketplaceContract: this.contract.address,
                  substandardRequests: [
                    {
                      requestedReceivedItems: order.params.consideration.map((c) => ({
                        ...c,
                        // All criteria items should have been resolved
                        itemType: c.itemType > 3 ? c.itemType - 2 : c.itemType,
                        // Adjust the amount to the quantity filled (won't work for dutch auctions)
                        amount: bn(matchParams.amount ?? 1)
                          .mul(c.endAmount)
                          .div(order.getInfo()!.amount)
                          .toString(),
                        identifier:
                          c.itemType > 3
                            ? matchParams.criteriaResolvers![0].identifier
                            : c.identifierOrCriteria,
                      })),
                    },
                  ],
                },
              ],
            }
          )
          .then((response) => response.data.orders[0].extraDataComponent);
      }

      default:
        return "0x";
    }
  }

  // --- Get counter (eg. nonce) ---

  public async getCounter(provider: Provider, user: string): Promise<BigNumberish> {
    return this.contract.connect(provider).getCounter(user);
  }

  // --- Derive conduit from key ---

  public deriveConduit(conduitKey: string) {
    return conduitKey === HashZero
      ? Addresses.Exchange[this.chainId]
      : "0x" +
          solidityKeccak256(
            ["bytes1", "address", "bytes32", "bytes32"],
            [
              "0xff",
              Addresses.ConduitController[this.chainId],
              conduitKey,
              // https://github.com/ProjectOpenSea/seaport/blob/0a8e82ce7262b5ce0e67fa98a2131fd4c47c84e9/contracts/conduit/ConduitController.sol#L493
              "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
            ]
          ).slice(-40);
  }

  // --- Derive basic sale information ---

  public deriveBasicSale(spentItems: Types.SpentItem[], receivedItems: Types.ReceivedItem[]) {
    // Normalize
    const nSpentItems: Types.SpentItem[] = [];
    for (const spentItem of spentItems) {
      nSpentItems.push({
        itemType: n(spentItem.itemType),
        token: lc(spentItem.token),
        identifier: s(spentItem.identifier),
        amount: s(spentItem.amount),
      });
    }
    const nReceivedItems: Types.ReceivedItem[] = [];
    for (const receivedItem of receivedItems) {
      nReceivedItems.push({
        itemType: n(receivedItem.itemType),
        token: lc(receivedItem.token),
        identifier: s(receivedItem.identifier),
        amount: s(receivedItem.amount),
        recipient: lc(receivedItem.recipient),
      });
    }

    try {
      if (nSpentItems.length === 1) {
        if (nSpentItems[0].itemType >= 2) {
          // Listing got filled

          const mainConsideration = nReceivedItems[0];
          if (mainConsideration.itemType >= 2) {
            throw new Error("Not a basic sale");
          }

          // Keep track of any "false" consideration items and remove them from price computation
          const falseReceivedItemsIndexes: number[] = [];
          let recipientOverride: string | undefined;
          for (let i = 1; i < nReceivedItems.length; i++) {
            if (
              nReceivedItems[i].itemType == nSpentItems[0].itemType &&
              nReceivedItems[i].token == nSpentItems[0].token &&
              nReceivedItems[i].identifier == nSpentItems[0].identifier
            ) {
              recipientOverride = nReceivedItems[i].recipient;
              falseReceivedItemsIndexes.push(i);
            } else if (
              nReceivedItems[i].itemType !== mainConsideration.itemType ||
              nReceivedItems[i].token !== mainConsideration.token
            ) {
              throw new Error("Not a basic sale");
            }
          }

          return {
            // To cover the generic `matchOrders` case
            recipientOverride,
            contract: nSpentItems[0].token,
            tokenId: nSpentItems[0].identifier,
            amount: nSpentItems[0].amount,
            paymentToken: mainConsideration.token,
            price: nReceivedItems
              .filter((_, i) => !falseReceivedItemsIndexes.includes(i))
              .map((c) => bn(c.amount))
              .reduce((a, b) => a.add(b))
              .toString(),
            side: "sell",
          };
        } else {
          // Bid got filled

          const mainConsideration = nReceivedItems[0];
          if (mainConsideration.itemType < 2) {
            throw new Error("Not a basic sale");
          }

          for (let i = 1; i < nReceivedItems.length; i++) {
            if (
              nReceivedItems[i].itemType !== nSpentItems[0].itemType ||
              nReceivedItems[i].token !== nSpentItems[0].token
            ) {
              throw new Error("Not a basic sale");
            }
          }

          return {
            recipientOverride: undefined,
            contract: mainConsideration.token,
            tokenId: mainConsideration.identifier,
            amount: mainConsideration.amount,
            paymentToken: nSpentItems[0].token,
            price: nSpentItems[0].amount,
            side: "buy",
          };
        }
      }
    } catch {
      return undefined;
    }
  }
}
