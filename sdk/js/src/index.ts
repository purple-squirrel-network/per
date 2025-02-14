import type { components, paths } from "./serverTypes";
import createClient, {
  ClientOptions as FetchClientOptions,
} from "openapi-fetch";
import { Address, Hex, isAddress, isHex } from "viem";
import WebSocket from "isomorphic-ws";
import {
  Bid,
  BidId,
  BidParams,
  BidsResponse,
  BidStatusUpdate,
  BidSvm,
  ExpressRelaySvmConfig,
  Opportunity,
  OpportunityBid,
  OpportunityEvm,
  OpportunityCreate,
  TokenAmount,
  SvmChainUpdate,
  OpportunityDelete,
  ChainType,
} from "./types";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { limoId, Order } from "@kamino-finance/limo-sdk";
import { getPdaAuthority } from "@kamino-finance/limo-sdk/dist/utils";
import * as evm from "./evm";
import * as svm from "./svm";

export * from "./types";
export * from "./const";

export class ClientError extends Error {
  static newHttpError(error: string, status?: number) {
    const message = `Auction server http error ${status ?? ""} - ${error}`;
    return new ClientError(message);
  }

  static newWebsocketError(error: string) {
    const message = `Auction server websocket error - ${error}`;
    return new ClientError(message);
  }
}

type ClientOptions = FetchClientOptions & {
  baseUrl: string;
  apiKey?: string;
};

export interface WsOptions {
  /**
   * Max time to wait for a response from the server in milliseconds
   */
  response_timeout: number;
  /**
   * Heartbeat interval at which the server is expected to send a ping
   */
  ping_interval: number;
}

const DEFAULT_WS_OPTIONS: WsOptions = {
  response_timeout: 10000,
  ping_interval: 32000, // 30 seconds + 2 seconds to account for extra latency
};

export function checkHex(hex: string): Hex {
  if (isHex(hex)) {
    return hex;
  }
  throw new ClientError(`Invalid hex: ${hex}`);
}

export function checkAddress(address: string): Address {
  if (isAddress(address)) {
    return address;
  }
  throw new ClientError(`Invalid address: ${address}`);
}

export function checkTokenQty(token: {
  token: string;
  amount: string;
}): TokenAmount {
  return {
    token: checkAddress(token.token),
    amount: BigInt(token.amount),
  };
}

export class Client {
  public clientOptions: ClientOptions;
  public wsOptions: WsOptions;
  public websocket?: WebSocket;
  public idCounter = 0;
  public callbackRouter: Record<
    string,
    (response: components["schemas"]["ServerResultMessage"]) => void
  > = {};
  private pingTimeout: NodeJS.Timeout | undefined;
  private websocketOpportunityCallback?: (
    opportunity: Opportunity
  ) => Promise<void>;

  private websocketBidStatusCallback?: (
    statusUpdate: BidStatusUpdate
  ) => Promise<void>;

  private websocketSvmChainUpdateCallback?: (
    update: SvmChainUpdate
  ) => Promise<void>;

  private websocketRemoveOpportunitiesCallback?: (
    opportunityDelete: OpportunityDelete
  ) => Promise<void>;

  private websocketCloseCallback: () => Promise<void>;

  private getAuthorization() {
    return this.clientOptions.apiKey
      ? {
          Authorization: `Bearer ${this.clientOptions.apiKey}`,
        }
      : {};
  }

  constructor(
    clientOptions: ClientOptions,
    wsOptions?: WsOptions,
    opportunityCallback?: (opportunity: Opportunity) => Promise<void>,
    bidStatusCallback?: (statusUpdate: BidStatusUpdate) => Promise<void>,
    svmChainUpdateCallback?: (update: SvmChainUpdate) => Promise<void>,
    removeOpportunitiesCallback?: (
      opportunityDelete: OpportunityDelete
    ) => Promise<void>,
    websocketCloseCallback?: () => Promise<void>
  ) {
    this.clientOptions = clientOptions;
    this.clientOptions.headers = {
      ...(this.clientOptions.headers ?? {}),
      ...this.getAuthorization(),
    };
    this.wsOptions = { ...DEFAULT_WS_OPTIONS, ...wsOptions };
    this.pingTimeout = undefined;
    this.websocketOpportunityCallback = opportunityCallback;
    this.websocketBidStatusCallback = bidStatusCallback;
    this.websocketSvmChainUpdateCallback = svmChainUpdateCallback;
    this.websocketRemoveOpportunitiesCallback = removeOpportunitiesCallback;
    this.websocketCloseCallback =
      websocketCloseCallback ??
      (() => {
        throw ClientError.newWebsocketError("Websocket connection was closed");
      });
  }

  private connectWebsocket() {
    const websocketEndpoint = new URL(this.clientOptions.baseUrl);
    websocketEndpoint.protocol =
      websocketEndpoint.protocol === "https:" ? "wss:" : "ws:";
    websocketEndpoint.pathname = "/v1/ws";

    this.websocket = new WebSocket(websocketEndpoint.toString(), {
      headers: this.getAuthorization(),
    });
    this.websocket.on("message", async (data: string) => {
      const message:
        | components["schemas"]["ServerResultResponse"]
        | components["schemas"]["ServerUpdateResponse"] = JSON.parse(
        data.toString()
      );
      if ("type" in message && message.type === "new_opportunity") {
        if (typeof this.websocketOpportunityCallback === "function") {
          const convertedOpportunity = this.convertOpportunity(
            message.opportunity
          );
          if (convertedOpportunity !== undefined) {
            await this.websocketOpportunityCallback(convertedOpportunity);
          }
        }
      } else if ("type" in message && message.type === "bid_status_update") {
        if (typeof this.websocketBidStatusCallback === "function") {
          await this.websocketBidStatusCallback({
            id: message.status.id,
            ...message.status.bid_status,
          });
        }
      } else if ("type" in message && message.type === "svm_chain_update") {
        if (typeof this.websocketSvmChainUpdateCallback === "function") {
          await this.websocketSvmChainUpdateCallback({
            chainId: message.update.chain_id,
            blockhash: message.update.blockhash,
            latestPrioritizationFee: BigInt(
              message.update.latest_prioritization_fee
            ),
          });
        }
      } else if ("type" in message && message.type === "remove_opportunities") {
        if (typeof this.websocketRemoveOpportunitiesCallback === "function") {
          const opportunityDelete: OpportunityDelete =
            message.opportunity_delete.chain_type === ChainType.EVM
              ? {
                  chainType: ChainType.EVM,
                  chainId: message.opportunity_delete.chain_id,
                  permissionKey: checkHex(
                    message.opportunity_delete.permission_key
                  ),
                }
              : {
                  chainType: ChainType.SVM,
                  chainId: message.opportunity_delete.chain_id,
                  program: message.opportunity_delete.program,
                  permissionAccount: new PublicKey(
                    message.opportunity_delete.permission_account
                  ),
                  router: new PublicKey(message.opportunity_delete.router),
                };

          await this.websocketRemoveOpportunitiesCallback(opportunityDelete);
        }
      } else if ("id" in message && message.id) {
        // Response to a request sent earlier via the websocket with the same id
        const callback = this.callbackRouter[message.id];
        if (callback !== undefined) {
          callback(message);
          delete this.callbackRouter[message.id];
        }
      } else if ("error" in message) {
        // Can not route error messages to the callback router as they don't have an id
        console.error(message.error);
      }
    });
    this.websocket.on("error", (error) => {
      console.error(ClientError.newWebsocketError(error.message));
    });
    this.websocket.on("ping", () => {
      if (this.pingTimeout !== undefined) {
        clearTimeout(this.pingTimeout);
      }

      this.pingTimeout = setTimeout(() => {
        console.error(
          ClientError.newWebsocketError(
            "Received no ping. Terminating connection."
          )
        );
        this.websocket?.terminate();
      }, this.wsOptions.ping_interval);
    });

    this.websocket.on("close", () => {
      // TODO: can we reconnect?
      this.websocketCloseCallback();
    });
  }

  /**
   * Subscribes to the specified chains
   *
   * The opportunity handler will be called for opportunities on the specified chains
   * If the opportunity handler is not set, an error will be thrown
   * @param chains
   */
  async subscribeChains(chains: string[]): Promise<void> {
    if (this.websocketOpportunityCallback === undefined) {
      throw new ClientError("Opportunity handler not set");
    }
    await this.requestViaWebsocket({
      method: "subscribe",
      params: {
        chain_ids: chains,
      },
    });
  }

  /**
   * Unsubscribes from the specified chains
   *
   * The opportunity handler will no longer be called for opportunities on the specified chains
   * @param chains
   */
  async unsubscribeChains(chains: string[]): Promise<void> {
    await this.requestViaWebsocket({
      method: "unsubscribe",
      params: {
        chain_ids: chains,
      },
    });
  }

  async requestViaWebsocket(
    msg: components["schemas"]["ClientMessage"]
  ): Promise<components["schemas"]["APIResponse"] | null> {
    const msg_with_id: components["schemas"]["ClientRequest"] = {
      ...msg,
      id: (this.idCounter++).toString(),
    };
    return new Promise((resolve, reject) => {
      this.callbackRouter[msg_with_id.id] = (response) => {
        if (response.status === "success") {
          resolve(response.result);
        } else {
          reject(ClientError.newWebsocketError(response.result));
        }
      };
      if (this.websocket === undefined) {
        this.connectWebsocket();
      }
      if (this.websocket !== undefined) {
        if (this.websocket.readyState === WebSocket.CONNECTING) {
          this.websocket.on("open", () => {
            this.websocket?.send(JSON.stringify(msg_with_id));
          });
        } else if (this.websocket.readyState === WebSocket.OPEN) {
          this.websocket.send(JSON.stringify(msg_with_id));
        } else {
          reject(
            ClientError.newWebsocketError(
              "Websocket connection closing or already closed"
            )
          );
        }
      }
      setTimeout(() => {
        delete this.callbackRouter[msg_with_id.id];
        reject(ClientError.newWebsocketError("Websocket response timeout"));
      }, this.wsOptions.response_timeout);
    });
  }

  /**
   * Fetches opportunities
   * @param chainId Chain id to fetch opportunities for. e.g: sepolia
   * @param fromTime A date object representing the datetime to fetch opportunities from. If undefined, fetches from the beginning of time.
   * @param limit Number of opportunities to return
   * @returns List of opportunities
   */
  async getOpportunities(
    chainId?: string,
    fromTime?: Date,
    limit?: number
  ): Promise<Opportunity[]> {
    const client = createClient<paths>(this.clientOptions);
    const opportunities = await client.GET("/v1/opportunities", {
      params: {
        query: { chain_id: chainId, from_time: fromTime?.toISOString(), limit },
      },
    });
    if (opportunities.data === undefined) {
      throw new ClientError("No opportunities found");
    }
    return opportunities.data.flatMap((opportunity) => {
      const convertedOpportunity = this.convertOpportunity(opportunity);
      if (convertedOpportunity === undefined) {
        return [];
      }
      return convertedOpportunity;
    });
  }

  /**
   * Submits an opportunity to be exposed to searchers
   * @param opportunity Opportunity to submit
   */
  async submitOpportunity(opportunity: OpportunityCreate) {
    const client = createClient<paths>(this.clientOptions);
    let body;
    if ("order" in opportunity) {
      const encoded_order = Buffer.alloc(
        Order.discriminator.length + Order.layout.span
      );
      Order.discriminator.copy(encoded_order);
      Order.layout.encode(
        opportunity.order.state,
        encoded_order,
        Order.discriminator.length
      );
      const remainingOutputAmount = anchor.BN.max(
        opportunity.order.state.expectedOutputAmount.sub(
          opportunity.order.state.filledOutputAmount
        ),
        new anchor.BN(0)
      );
      body = {
        chain_id: opportunity.chainId,
        version: "v1" as const,
        program: opportunity.program,

        order: encoded_order.toString("base64"),
        slot: opportunity.slot,
        order_address: opportunity.order.address.toBase58(),
        buy_tokens: [
          {
            token: opportunity.order.state.inputMint.toBase58(),
            amount: opportunity.order.state.remainingInputAmount.toNumber(),
          },
        ],
        sell_tokens: [
          {
            token: opportunity.order.state.outputMint.toBase58(),
            amount: remainingOutputAmount.toNumber(),
          },
        ],
        permission_account: opportunity.order.address.toBase58(),
        router: getPdaAuthority(
          limoId,
          opportunity.order.state.globalConfig
        ).toBase58(),
      };
    } else {
      body = {
        chain_id: opportunity.chainId,
        version: "v1" as const,
        permission_key: opportunity.permissionKey,
        target_contract: opportunity.targetContract,
        target_calldata: opportunity.targetCalldata,
        target_call_value: opportunity.targetCallValue.toString(),
        sell_tokens: opportunity.sellTokens.map(({ token, amount }) => ({
          token,
          amount: amount.toString(),
        })),
        buy_tokens: opportunity.buyTokens.map(({ token, amount }) => ({
          token,
          amount: amount.toString(),
        })),
      };
    }
    const response = await client.POST("/v1/opportunities", {
      body: body,
    });
    if (response.error) {
      throw ClientError.newHttpError(
        response.error.error,
        response.response.status
      );
    }
  }

  /**
   * Remove an opportunity from the server and update the searchers
   * @param opportunity Opportunity to be removed
   */
  async removeOpportunity(opportunity: OpportunityDelete) {
    if (opportunity.chainType === ChainType.EVM) {
      throw new ClientError("Only SVM opportunities can be removed");
    }

    if (opportunity.program !== "limo") {
      throw new ClientError("Only limo opportunities can be removed");
    }

    const client = createClient<paths>(this.clientOptions);
    const body = {
      chain_type: opportunity.chainType,
      chain_id: opportunity.chainId,
      version: "v1" as const,
      program: opportunity.program,
      permission_account: opportunity.permissionAccount.toBase58(),
      router: opportunity.router.toBase58(),
    };
    const response = await client.DELETE("/v1/opportunities", {
      body,
    });
    if (response.error) {
      throw ClientError.newHttpError(
        response.error.error,
        response.response.status
      );
    }
  }

  /**
   * Submits a raw bid for a permission key
   * @param bid
   * @param subscribeToUpdates If true, the client will subscribe to bid status updates via websocket and will call the bid status callback if set
   * @returns The id of the submitted bid, you can use this id to track the status of the bid
   */
  async submitBid(bid: Bid, subscribeToUpdates = true): Promise<BidId> {
    const serverBid = this.toServerBid(bid);
    if (subscribeToUpdates) {
      const result = await this.requestViaWebsocket({
        method: "post_bid",
        params: {
          bid: serverBid,
        },
      });

      if (result === null) {
        throw ClientError.newWebsocketError(
          "Empty response in websocket for bid submission"
        );
      }

      return result.id;
    } else {
      const client = createClient<paths>(this.clientOptions);
      const response = await client.POST("/v1/bids", {
        body: serverBid,
      });
      if (response.error) {
        throw ClientError.newHttpError(
          response.error.error,
          response.response.status
        );
      } else if (response.data === undefined) {
        throw ClientError.newHttpError("No data returned");
      } else {
        return response.data.id;
      }
    }
  }

  /**
   * Get bids for an api key
   * @param fromTime The datetime to fetch bids from. If undefined or null, fetches from the beginning of time.
   * @returns The paginated bids response
   */
  async getBids(fromTime?: Date): Promise<BidsResponse> {
    const client = createClient<paths>(this.clientOptions);
    const response = await client.GET("/v1/bids", {
      params: { query: { from_time: fromTime?.toISOString() } },
    });
    if (response.error) {
      throw ClientError.newHttpError(
        response.error.error,
        response.response.status
      );
    } else if (response.data === undefined) {
      throw ClientError.newHttpError("No data returned");
    } else {
      return response.data;
    }
  }

  private toServerBid(bid: Bid): components["schemas"]["BidCreate"] {
    if (bid.env === "evm") {
      return {
        amount: bid.amount.toString(),
        target_calldata: bid.targetCalldata,
        chain_id: bid.chainId,
        target_contract: bid.targetContract,
        permission_key: bid.permissionKey,
      };
    }

    return {
      chain_id: bid.chainId,
      transaction: bid.transaction
        .serialize({ requireAllSignatures: false })
        .toString("base64"),
    };
  }

  /**
   * Converts an opportunity from the server to the client format
   * Returns undefined if the opportunity version is not supported
   * @param opportunity
   * @returns Opportunity in the converted client format
   */
  public convertOpportunity(
    opportunity: components["schemas"]["Opportunity"]
  ): Opportunity | undefined {
    if (opportunity.version !== "v1") {
      console.warn(
        `Can not handle opportunity version: ${opportunity.version}. Please upgrade your client.`
      );
      return undefined;
    }
    if ("target_calldata" in opportunity) {
      return {
        chainId: opportunity.chain_id,
        opportunityId: opportunity.opportunity_id,
        permissionKey: checkHex(opportunity.permission_key),
        targetContract: checkAddress(opportunity.target_contract),
        targetCalldata: checkHex(opportunity.target_calldata),
        targetCallValue: BigInt(opportunity.target_call_value),
        sellTokens: opportunity.sell_tokens.map(checkTokenQty),
        buyTokens: opportunity.buy_tokens.map(checkTokenQty),
      };
    }
    if ("order" in opportunity) {
      const order = Order.decode(Buffer.from(opportunity.order, "base64"));
      return {
        chainId: opportunity.chain_id,
        slot: opportunity.slot,
        opportunityId: opportunity.opportunity_id,
        order: {
          state: order,
          address: new PublicKey(opportunity.order_address),
        },
        program: "limo",
      };
    } else {
      console.warn("Cannot handle wallet opportunities");
      return undefined;
    }
  }

  // EVM specific functions

  /**
   * Creates a signed opportunity bid for an opportunity
   * @param opportunity EVM Opportunity to bid on
   * @param bidParams Bid amount and valid until timestamp
   * @param privateKey Private key to sign the bid with
   * @returns Signed opportunity bid
   */
  async signOpportunityBid(
    opportunity: OpportunityEvm,
    bidParams: BidParams,
    privateKey: Hex
  ): Promise<OpportunityBid> {
    return evm.signOpportunityBid(opportunity, bidParams, privateKey);
  }

  /**
   * Creates a signed bid for an EVM opportunity
   * @param opportunity EVM Opportunity to bid on
   * @param bidParams Bid amount, nonce, and deadline timestamp
   * @param privateKey Private key to sign the bid with
   * @returns Signed bid
   */
  async signBid(
    opportunity: OpportunityEvm,
    bidParams: BidParams,
    privateKey: Hex
  ): Promise<Bid> {
    return evm.signBid(opportunity, bidParams, privateKey);
  }

  /**
   * Creates a signature for the bid and opportunity
   * @param opportunity EVM Opportunity to bid on
   * @param bidParams Bid amount, nonce, and deadline timestamp
   * @param privateKey Private key to sign the bid with
   * @returns Signature for the bid and opportunity
   */
  async getSignature(
    opportunity: OpportunityEvm,
    bidParams: BidParams,
    privateKey: Hex
  ): Promise<`0x${string}`> {
    return evm.getSignature(opportunity, bidParams, privateKey);
  }

  // SVM specific functions

  /**
   * Fetches the Express Relay SVM config necessary for bidding
   * @param chainId The id for the chain you want to fetch the config for
   * @param connection The connection to use for fetching the config
   */
  async getExpressRelaySvmConfig(
    chainId: string,
    connection: Connection
  ): Promise<ExpressRelaySvmConfig> {
    return svm.getExpressRelaySvmConfig(chainId, connection);
  }

  /**
   * Constructs a SubmitBid instruction, which can be added to a transaction to permission it on the given permission key
   * @param searcher The address of the searcher that is submitting the bid
   * @param router The identifying address of the router that the permission key is for
   * @param permissionKey The 32-byte permission key as an SVM PublicKey
   * @param bidAmount The amount of the bid in lamports
   * @param deadline The deadline for the bid in seconds since Unix epoch
   * @param chainId The chain ID as a string, e.g. "solana"
   * @param relayerSigner The address of the relayer that is submitting the bid
   * @param feeReceiverRelayer The fee collection address of the relayer
   * @returns The SubmitBid instruction
   */
  async constructSubmitBidInstruction(
    searcher: PublicKey,
    router: PublicKey,
    permissionKey: PublicKey,
    bidAmount: anchor.BN,
    deadline: anchor.BN,
    chainId: string,
    relayerSigner: PublicKey,
    feeReceiverRelayer: PublicKey
  ): Promise<TransactionInstruction> {
    return svm.constructSubmitBidInstruction(
      searcher,
      router,
      permissionKey,
      bidAmount,
      deadline,
      chainId,
      relayerSigner,
      feeReceiverRelayer
    );
  }

  /**
   * Constructs an SVM bid, by adding a SubmitBid instruction to a transaction
   * @param tx The transaction to add a SubmitBid instruction to. This transaction should already check for the appropriate permissions.
   * @param searcher The address of the searcher that is submitting the bid
   * @param router The identifying address of the router that the permission key is for
   * @param permissionKey The 32-byte permission key as an SVM PublicKey
   * @param bidAmount The amount of the bid in lamports
   * @param deadline The deadline for the bid in seconds since Unix epoch
   * @param chainId The chain ID as a string, e.g. "solana"
   * @param relayerSigner The address of the relayer that is submitting the bid
   * @param feeReceiverRelayer The fee collection address of the relayer
   * @returns The constructed SVM bid
   */
  async constructSvmBid(
    tx: Transaction,
    searcher: PublicKey,
    router: PublicKey,
    permissionKey: PublicKey,
    bidAmount: anchor.BN,
    deadline: anchor.BN,
    chainId: string,
    relayerSigner: PublicKey,
    feeReceiverRelayer: PublicKey
  ): Promise<BidSvm> {
    return svm.constructSvmBid(
      tx,
      searcher,
      router,
      permissionKey,
      bidAmount,
      deadline,
      chainId,
      relayerSigner,
      feeReceiverRelayer
    );
  }
}
