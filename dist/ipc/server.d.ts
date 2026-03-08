/**
 * IPC Server - Unix Domain Socket server
 * Implements §3.2.4 connection lifecycle
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { IpcMessage } from './types.js';
export declare const IDLE_TIMEOUT_MS: number;
export interface IpcServerOptions {
    socketPath: string;
    /** Socket file permission (default: 0o660) */
    mode?: number;
}
export type MessageHandler = (message: IpcMessage, connection: IpcConnection) => void | Promise<void>;
/**
 * Represents a single client connection.
 */
export declare class IpcConnection {
    private readonly socket;
    readonly id: string;
    constructor(socket: net.Socket);
    send(message: IpcMessage): void;
    close(): void;
    get destroyed(): boolean;
}
/**
 * IPC Server events:
 * - 'connection': (conn: IpcConnection) => void
 * - 'message': (msg: IpcMessage, conn: IpcConnection) => void
 * - 'error': (err: Error) => void
 * - 'close': () => void
 */
export declare class IpcServer extends EventEmitter {
    private server;
    private readonly connections;
    /** Maps agentSessionId → IpcConnection for targeted message delivery (M-3) */
    private readonly agentSessionMap;
    private readonly options;
    constructor(options: IpcServerOptions);
    private handleSocket;
    /**
     * Start listening. Removes stale socket file if exists.
     */
    listen(): Promise<void>;
    /**
     * Attempts to set socket file group ownership to 'openclaw-agent'.
     * Non-fatal: logs a warning if group does not exist or chown fails.
     */
    private _chownSocketToOpenclaw;
    /**
     * Resolves the GID of a group by parsing /etc/group.
     * Returns null if group is not found or file is unreadable.
     */
    private _resolveGroupGid;
    /**
     * Send a message to a specific agentSessionId (M-1).
     * Returns true if the connection exists and is active, false otherwise.
     */
    send(sessionId: string, message: IpcMessage): boolean;
    /**
     * Check if the connection for a given agentSessionId is active (M-2).
     */
    isActive(sessionId: string): boolean;
    /**
     * Broadcast a message to all connections.
     */
    broadcast(message: IpcMessage): void;
    /**
     * Close the server and all connections.
     */
    close(): Promise<void>;
    get connectionCount(): number;
}
//# sourceMappingURL=server.d.ts.map