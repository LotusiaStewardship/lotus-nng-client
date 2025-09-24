/**
 * Copyright 2025 The Lotusia Stewardship
 * Github: https://github.com/LotusiaStewardship
 * License: MIT
 */
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { Socket, socket } from 'nanomsg'
import { Builder, ByteBuffer } from 'flatbuffers'
import {
  RpcRequest,
  RpcResult,
  GetMempoolRequest,
  GetBlockRangeRequest,
  GetBlockRequest,
  BlockIdentifier,
  BlockHeight,
  RpcCall,
  Block as BlockNNG,
  GetBlockResponse,
  GetMempoolResponse,
  GetBlockRangeResponse,
  Hash,
  BlockHeader,
} from './nng-interface'
import { config } from 'dotenv'
/**
 * NNG configuration
 */
export const NNG_SUB_SOCKET_PATH_DEFAULT = `${os.homedir()}/.lotus/pub.pipe`
export const NNG_REQ_SOCKET_PATH_DEFAULT = `${os.homedir()}/.lotus/rpc.pipe`
/** Max block size in bytes for requests to RPC socket (32 MiB, i.e. 2^20 * 32) */
export const NNG_RPC_RCVMAXSIZE_POLICY = 33_554_432
/** Max number of blocks to request in a single block range request (20) */
export const NNG_RPC_BLOCKRANGE_SIZE = 20
/** Time (ms) between reconnect attempts */
export const NNG_SOCKET_RECONN = 300
/** Max time (ms) before giving up reconnect */
export const NNG_SOCKET_MAXRECONN = 3_000
/** Max time (ms) before aborting a Socket.send() */
export const NNG_REQUEST_TIMEOUT_LENGTH = 2_000
/** Number of messages to process in each batch */
export const NNG_MESSAGE_BATCH_SIZE = 10
/** Valid socket types */
export const NNG_SOCKET_TYPES = ['sub', 'req']
/**
 * Dotenv configuration
 */
const parsed = config({ path: '.env' }).parsed
if (!parsed) {
  throw new Error('Failed to load .env file')
}
export const subSocketPath =
  parsed.NNG_SUB_SOCKET_PATH || NNG_SUB_SOCKET_PATH_DEFAULT
export const reqSocketPath =
  parsed.NNG_REQ_SOCKET_PATH || NNG_REQ_SOCKET_PATH_DEFAULT

/** NNG types */
export type NNGSocketParameters = {
  type: NNGSocketType
  path?: string
  channels?: Array<NNGMessageType>
}
export type NNGSocketType = 'pub' | 'sub' | 'req' | 'rep'
export type NNGMessageType =
  | 'mempooltxadd'
  | 'mempooltxrem'
  | 'blkconnected'
  | 'blkdisconctd'
export type NNGMessageProcessor = (bb: ByteBuffer) => Promise<void>
export type NNGPendingMessage = [NNGMessageType, ByteBuffer]
export type NNGQueue = {
  busy: boolean
  pending: NNGPendingMessage[]
}

/** Block object, parsed from `NNG.BlockHeader` flatbuffer */
export type Block = {
  hash: string
  height: number
  timestamp: bigint
  ranksLength: number // default is 0 if a block is cringe
  rnkcsLength: number // default is 0 if a block is cringe
  prevhash?: string // for reorg checks only; does not get saved to database
}
/**
 * Error codes
 */
export enum ERR {
  NNG_CONNECT = 1,
  NNG_RECEIVE_MESSAGE,
  NNG_PROCESS_MESSAGE,
  NNG_SEND_MESSAGE,
  NNG_SEND_AND_WAIT,
  NNG_RPC_CALL,
  NNG_RPC_GET_MEMPOOL,
  NNG_RPC_GET_BLOCK,
  NNG_RPC_GET_BLOCK_RANGE,
}

/**
 * Lotus NNG interface
 */
export class NNG extends EventEmitter {
  private queue: NNGQueue
  private sockets: Record<NNGSocketType, Socket>
  private registeredProcessors: Partial<
    Record<NNGMessageType, NNGMessageProcessor>
  >
  /**
   * Instantiate and configure Lotus NNG sockets
   * @param sockets - The sockets to connect to
   * @param processors - The processors to register
   */
  constructor({
    sockets,
    processors,
  }: {
    sockets: Array<NNGSocketParameters>
    processors: Partial<Record<NNGMessageType, NNGMessageProcessor>>
  }) {
    super()
    this.queue = { busy: false, pending: [] }
    this.registeredProcessors = processors
    this.sockets = {} as typeof this.sockets
    sockets.forEach(({ type, path }) => {
      // Create socket
      const socket = this.createSocket(type)
      // Set up socket depending on type
      switch (type) {
        // Lotus RPC socket
        case 'req':
          // RPC socket has a larger receive buffer to handle large block range requests
          socket.rcvmaxsize(NNG_RPC_RCVMAXSIZE_POLICY * NNG_RPC_BLOCKRANGE_SIZE)
          socket.connect(`ipc://${path ?? reqSocketPath}`)
          break
        // Lotus event socket
        case 'sub':
          // Set up message listener
          socket.on('data', this.nngReceiveMessage)
          socket.rcvmaxsize(NNG_RPC_RCVMAXSIZE_POLICY)
          socket.connect(`ipc://${path ?? subSocketPath}`)
          break
      }
      this.sockets[type] = socket
    })
  }
  /**
   * Subscribe to channels on a socket
   * @param socketType - The type of socket to subscribe to
   * @param channels - The channels to subscribe to
   */
  subscribe(socketType: NNGSocketType, channels: Array<NNGMessageType>) {
    this.sockets[socketType].chan(channels)
  }
  /**
   * Close the Lotus NNG sockets
   */
  close() {
    Object.values(this.sockets).forEach(socket => {
      socket.close()
    })
  }
  /**
   * Register a new NNG message processor or replace an existing one
   * @param messageType - The type of message to register the processor for
   * @param processor - The processor to register
   */
  registerProcessor(
    messageType: NNGMessageType,
    processor: NNGMessageProcessor,
  ) {
    this.registeredProcessors[messageType] = processor
  }
  /**
   * Create a Lotus NNG socket
   * @param socketType - The type of socket to create
   * @returns The socket
   */
  private createSocket(socketType: NNGSocketType) {
    // Create socket
    const sock = socket(socketType)
    // Set universal socket options and return socket
    sock.reconn(NNG_SOCKET_RECONN)
    sock.maxreconn(NNG_SOCKET_MAXRECONN)
    return sock
  }
  /**
   * Receive a message from the NNG socket and add its processor and message data to the queue
   *
   * Defined as arrow function to bind `this` to the class instance
   * @param msg - The message to receive
   * @returns {Promise<void>}
   */
  private nngReceiveMessage = async (msg: Buffer): Promise<void> => {
    // Parse out the message type and convert message to ByteBuffer
    const msgType = msg.subarray(0, 12).toString() as NNGMessageType
    const bb = new ByteBuffer(msg.subarray(12))
    // Check if the message type has a registered processor
    if (this.registeredProcessors[msgType] === undefined) {
      this.emit(
        'exception',
        ERR.NNG_RECEIVE_MESSAGE,
        `No processor registered for message type: ${msgType}`,
      )
      return
    }
    // Add the message type and data to the back of the processing queue
    this.queue.pending.push([msgType, bb])
    // Set immediate processing of the processing queue if not already busy
    if (!this.queue.busy) {
      setImmediate(this.nngProcessMessage)
    }
  }
  /**
   * Process the next message in the NNG queue
   *
   * Defined as arrow function to bind `this` to the class instance
   * @returns {Promise<void>}
   */
  private nngProcessMessage = async (): Promise<void> => {
    // Queue is now busy processing queued NNG handlers
    // Prevents clobbering; maintains healthy database state
    this.queue.busy = true
    // Process the next message from the queue
    try {
      // assume that the queue is not empty
      const [msgType, ByteBuffer] =
        this.queue.pending.shift() as NNGPendingMessage
      // assume that the message type has a registered processor
      await this.registeredProcessors[msgType]!(ByteBuffer)
    } catch (e: unknown) {
      // Should never get here; shut down if we do
      this.emit('exception', ERR.NNG_PROCESS_MESSAGE, (e as Error).message)
      this.queue.busy = false
      return
    }
    // Recursively process the next message in the queue
    if (this.queue.pending.length > 0) {
      return this.nngProcessMessage()
    }
    // queue is now idle
    this.queue.busy = false
  }
  /**
   * Fetches mempool txs
   * @returns {Promise<GetMempoolResponse>}
   */
  async rpcGetMempool(): Promise<GetMempoolResponse | null> {
    try {
      const bb = await this.rpcCall('GetMempoolRequest')
      return bb instanceof ByteBuffer
        ? GetMempoolResponse.getRootAsGetMempoolResponse(bb)
        : null
    } catch (e: unknown) {
      throw new Error(`rpcGetMempool(): ${(e as Error).message}`)
    }
  }
  /**
   * Fetch block at `height`
   * @param height `height` parsed from `BlockHeader`
   * @returns {Promise<Block>}
   */
  async rpcGetBlock(height: number): Promise<BlockNNG | null> {
    try {
      const bb = await this.rpcCall('GetBlockRequest', {
        blockRequest: { height },
      })
      return bb instanceof ByteBuffer
        ? (GetBlockResponse.getRootAsGetBlockResponse(bb).block() as BlockNNG)
        : null
    } catch (e: unknown) {
      throw new Error(`rpcGetBlock(${height}): ${(e as Error).message}`)
    }
  }
  /**
   * Fetches range of blocks from `startHeight`, up to `numBlocks` limit
   * @param startHeight The starting `height` parsed from `BlockHeader`
   * @param numBlocks Configure `NNG_RPC_BLOCKRANGE_SIZE` in `/util/constants.ts` (default: 20)
   * @returns {Promise<GetBlockRangeResponse>}
   */
  async rpcGetBlockRange(
    startHeight: number,
    numBlocks: number,
  ): Promise<GetBlockRangeResponse | null> {
    try {
      const bb = await this.rpcCall('GetBlockRangeRequest', {
        blockRangeRequest: { startHeight, numBlocks },
      })
      return bb instanceof ByteBuffer
        ? GetBlockRangeResponse.getRootAsGetBlockRangeResponse(bb)
        : null
    } catch (e: unknown) {
      throw new Error(
        `rpcGetBlockRange(${startHeight}, ${numBlocks}): ${(e as Error).message}`,
      )
    }
  }
  /**
   * Send a request to the Lotus RPC request socket and return the response
   * @param rpcType - The type of RPC call to send
   * @param params - The parameters for the RPC call
   * @returns The response from the socket as a ByteBuffer, or null if the request times out
   */
  private async rpcCall(
    rpcType: keyof typeof RpcRequest,
    params?: {
      blockRangeRequest?: { startHeight: number; numBlocks: number }
      blockRequest?: { height: number }
    },
  ): Promise<ByteBuffer | null> {
    // Set up builder and get proper flatbuffer offset for rpcType
    const builder = new Builder()
    let offset: number
    switch (rpcType) {
      case 'GetMempoolRequest':
        offset = GetMempoolRequest.createGetMempoolRequest(builder)
        break
      case 'GetBlockRangeRequest': {
        if (!params?.blockRangeRequest) {
          throw new Error('parameters for "GetBlockRangeRequest" are required')
        }
        offset = GetBlockRangeRequest.createGetBlockRangeRequest(
          builder,
          params.blockRangeRequest.startHeight,
          params.blockRangeRequest.numBlocks,
        )
        break
      }
      case 'GetBlockRequest': {
        if (!params?.blockRequest) {
          throw new Error('parameters for "GetBlockRequest" are required')
        }
        offset = GetBlockRequest.createGetBlockRequest(
          builder,
          BlockIdentifier.Height,
          BlockHeight.createBlockHeight(builder, params.blockRequest.height),
        )
        break
      }
      default:
        throw new Error(`"${rpcType}" is not a valid RPC request`)
    }
    // Create RPC call and finish builder
    builder.finish(RpcCall.createRpcCall(builder, RpcRequest[rpcType], offset))
    // Send RPC call and wait for response; throw error if timeout
    let bb: ByteBuffer
    try {
      bb = await this.sendAndWait(builder.asUint8Array() as Buffer)
    } catch (e: unknown) {
      throw new Error(
        `rpcCall(${rpcType}, ${typeof params}): ${(e as Error).message}`,
      )
    }
    // Get the RPC result
    const result = RpcResult.getRootAsRpcResult(bb)
    if (!result.isSuccess()) {
      // If the RPC call was successful but returned error data, process that now
      switch (result.errorCode()) {
        case 5: // block not found
          return null
        // what's happening
        default:
          throw new Error(
            `rpcCall(${rpcType}, ${typeof params}): ${result.errorMsg()} (code: ${result.errorCode()})`,
          )
      }
    }
    // result.dataArray() is a Uint8Array, as the isSuccess() check above
    // ensures that the RPC call was successful
    return new ByteBuffer(result.dataArray() as Uint8Array)
  }
  /**
   * Send a request to the Lotus NNG RPC socket and return the response
   * @param msg - The message to send
   * @returns The response from the socket as a ByteBuffer
   */
  private async sendAndWait(msg: Buffer): Promise<ByteBuffer> {
    const socket = this.sockets.req
    return await new Promise((resolve, reject) => {
      const rpcSocketSendTimeout = setTimeout(
        () => reject(`Socket timeout (${NNG_REQUEST_TIMEOUT_LENGTH}ms)`),
        NNG_REQUEST_TIMEOUT_LENGTH,
      )
      // set up response listener before sending request; avoids race condition
      socket.once('data', (buf: Buffer) => {
        clearTimeout(rpcSocketSendTimeout)
        resolve(new ByteBuffer(buf))
      })
      socket.send(msg)
    })
  }
  /**
   * Parse raw `NNG.Hash` flatbuffer for the 32-byte block hash or txid
   * @param hash - The raw `NNG.Hash` flatbuffer
   * @returns The blockhash or txid
   */
  static toBlockhashOrTxid(hash: Hash) {
    // assume that the hash is valid
    const { bb_pos, bb } = hash
    return Buffer.from(
      bb!
        .bytes()
        .subarray(bb_pos, bb_pos + 32)
        .reverse(),
    ).toString('hex')
  }
  /**
   * Parse raw `NNG.BlockHeader` flatbuffer into a `Block` object
   * @param header - The raw `NNG.BlockHeader` flatbuffer
   * @param includePrevHash - Whether to include the previous block hash
   * @returns The block
   */
  static toBlock(header: BlockHeader, includePrevhash = false): Block {
    const height = this.toBlockHeight(header)
    const timestamp = header.timestamp()
    const hash = this.toBlockhashOrTxid(header.blockHash()!.hash()!)
    const block = { hash, height, timestamp } as Block
    if (includePrevhash) {
      block.prevhash = this.toBlockhashOrTxid(header.prevBlockHash()!.hash()!)
    }
    return block
  }

  /**
   * Parse raw `NNG.BlockHeader` flatbuffer for the nHeight
   * (https://docs.givelotus.org/specs/blockheader)
   * @param header - The raw `NNG.BlockHeader` flatbuffer
   * @returns The block height
   */
  static toBlockHeight(header: BlockHeader) {
    // assume that the rawArray of the header is valid
    const nHeight = header.rawArray()!.subarray(60, 64)
    return Buffer.from(nHeight).readUInt32LE()
  }
}
