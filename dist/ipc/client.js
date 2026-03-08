/**
 * IPC Client - Unix Domain Socket client
 * Implements §3.2.4 connection lifecycle (short-connection mode)
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { StreamParser } from './parser.js';
import { encodeMessage } from './framing.js';
/**
 * IPC Client events:
 * - 'message': (msg: IpcMessage) => void
 * - 'error': (err: Error) => void
 * - 'close': () => void
 */
export class IpcClient extends EventEmitter {
    socket = null;
    parser = null;
    options;
    constructor(options) {
        super();
        this.options = options;
    }
    /**
     * Connect to the daemon.
     */
    connect() {
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
    setupParser() {
        const socket = this.socket;
        this.parser = new StreamParser((result) => {
            if (result.ok) {
                this.emit('message', result.message);
            }
            else {
                this.emit('error', new Error(`${result.error.code}: ${result.error.message}`));
            }
        });
        socket.on('data', (chunk) => this.parser.push(chunk));
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
    send(message) {
        if (!this.socket || this.socket.destroyed) {
            throw new Error('Not connected');
        }
        this.socket.write(encodeMessage(message));
    }
    /**
     * Send a message and wait for the next response.
     */
    request(message, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Request timed out'));
            }, timeoutMs);
            const handler = (msg) => {
                clearTimeout(timer);
                resolve(msg);
            };
            this.once('message', handler);
            try {
                this.send(message);
            }
            catch (err) {
                clearTimeout(timer);
                this.off('message', handler);
                reject(err);
            }
        });
    }
    /**
     * Close the connection.
     */
    close() {
        if (this.socket && !this.socket.destroyed) {
            this.socket.end();
            this.socket = null;
        }
        this.parser?.reset();
        this.parser = null;
    }
    get connected() {
        return this.socket !== null && !this.socket.destroyed;
    }
}
//# sourceMappingURL=client.js.map