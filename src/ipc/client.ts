/**
 * IPC Client - Unix Domain Socket client
 * Implements §3.2.4 connection lifecycle (short-connection mode)
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { StreamParser, type ParseResult } from './parser.js';
import { encodeMessage } from './framing.js';
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
export class IpcClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser: StreamParser | null = null;
  private readonly options: IpcClientOptions;

  constructor(options: IpcClientOptions) {
    super();
    this.options = options;
  }

  /**
   * Connect to the daemon.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      const timeout = this.options.connectTimeoutMs ?? 5000;

      const timer = setTimeout(() => {
        socket.destroy(new Error(`Connection timed out after ${timeout}ms`));
        reject(new Error(`Connection timed out after ${timeout}ms`));
      }, timeout);

      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.setupParser();
        resolve();
      });

      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private setupParser(): void {
    const socket = this.socket!;

    this.parser = new StreamParser((result: ParseResult) => {
      if (result.ok) {
        this.emit('message', result.message);
      } else {
        this.emit('error', new Error(`${result.error.code}: ${result.error.message}`));
      }
    });

    socket.on('data', (chunk: Buffer) => this.parser!.push(chunk));
    socket.on('close', () => {
      this.parser?.reset();
      this.emit('close');
    });
    socket.on('error', (err) => {
      this.parser?.reset();
      this.emit('error', err);
    });
  }

  /**
   * Send a message to the daemon.
   */
  send(message: IpcMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected');
    }
    this.socket.write(encodeMessage(message));
  }

  /**
   * Send a message and wait for the next response.
   */
  request(message: IpcMessage, timeoutMs = 10000): Promise<IpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Request timed out'));
      }, timeoutMs);

      const handler = (msg: IpcMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };

      this.once('message', handler);

      try {
        this.send(message);
      } catch (err) {
        clearTimeout(timer);
        this.off('message', handler);
        reject(err);
      }
    });
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      this.socket = null;
    }
    this.parser?.reset();
    this.parser = null;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
