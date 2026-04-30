/**
 * IPC Client - Unix Domain Socket client
 * Implements §3.2.4 connection lifecycle (short-connection mode)
 */
import { EventEmitter } from 'node:events';
import type { IpcMessage } from './types.js';
export interface IpcClientOptions {
    socketPath: string;
    /** Connect timeout in ms (default: 5000) */
    connectTimeoutMs?: number;
}
/**
 * IPC Client events:
 * - 'message': (msg: IpcMessage) => void
 * - 'error': (err: Error) => void
 * - 'close': () => void
 */
export declare class IpcClient extends EventEmitter {
    private socket;
    private parser;
    private readonly options;
    constructor(options: IpcClientOptions);
    /**
     * Connect to the daemon.
     */
    connect(): Promise<void>;
    private setupParser;
    /**
     * Send a message to the daemon.
     */
    send(message: IpcMessage): void;
    /**
     * Send a message and wait for the next response.
     */
    request(message: IpcMessage, timeoutMs?: number): Promise<IpcMessage>;
    /**
     * Close the connection.
     */
    close(): void;
    get connected(): boolean;
}
//# sourceMappingURL=client.d.ts.map