import type {Readable} from 'node:stream';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CancelledNotificationSchema, isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse} from '@modelcontextprotocol/sdk/types.js';
import type {JSONRPCMessage, RequestId} from '@modelcontextprotocol/sdk/types.js';

/** A desktop half-close ends input but still delivers responses to requests
 * received before EOF. The desktop utility must exit explicitly afterward. */
export class DrainingMcpTransport extends StdioServerTransport {
  readonly #pending = new Set<RequestId>();
  #ended = false;
  #finish!: () => void;
  readonly drained = new Promise<void>(resolve => {this.#finish = resolve;});

  constructor(stdin: Readable) {
    super(stdin);
    stdin.once('end', () => {this.#ended = true; this.#settle();});
  }

  override async start(): Promise<void> {
    const dispatch = this.onmessage;
    this.onmessage = message => {
      if (isJSONRPCRequest(message)) this.#pending.add(message.id);
      else if ('method' in message && message.method === 'notifications/cancelled') {
        const cancelled = CancelledNotificationSchema.safeParse(message);
        if (cancelled.success && cancelled.data.params.requestId !== undefined) this.#pending.delete(cancelled.data.params.requestId);
      }
      dispatch?.(message);
    };
    await super.start();
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    try {
      await super.send(message);
    } finally {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if (message.id !== undefined) this.#pending.delete(message.id);
        this.#settle();
      }
    }
  }

  override async close(): Promise<void> {
    try {await super.close();}
    finally {this.#finish();}
  }

  #settle(): void {
    if (this.#ended && this.#pending.size === 0) this.#finish();
  }
}
