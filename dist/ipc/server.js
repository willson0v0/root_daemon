/**
 * IPC Server - Unix Domain Socket server
 * Implements §3.2.4 connection lifecycle
 */
import net from 'node:net';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StreamParser } from './parser.js';
import { encodeMessage } from './framing.js';
import { createError } from './types.js';
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
/**
 * Represents a single client connection.
 */
export class IpcConnection {
    socket;
    id;
    constructor(socket) {
        this.socket = socket;
        this.id = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    send(message) {
        if (!this.socket.destroyed) {
            this.socket.write(encodeMessage(message));
        }
    }
    close() {
        if (!this.socket.destroyed) {
            this.socket.end();
        }
    }
    get destroyed() {
        return this.socket.destroyed;
    }
}
/**
 * IPC Server events:
 * - 'connection': (conn: IpcConnection) => void
 * - 'message': (msg: IpcMessage, conn: IpcConnection) => void
 * - 'error': (err: Error) => void
 * - 'close': () => void
 */
export class IpcServer extends EventEmitter {
    server;
    connections = new Map();
    /** Maps agentSessionId → IpcConnection for targeted message delivery (M-3) */
    agentSessionMap = new Map();
    options;
    constructor(options) {
        super();
        this.options = options;
        this.server = net.createServer((socket) => this.handleSocket(socket));
        this.server.on('error', (err) => this.emit('error', err));
        this.server.on('close', () => this.emit('close'));
    }
    handleSocket(socket) {
        socket.setTimeout(IDLE_TIMEOUT_MS);
        socket.on('timeout', () => socket.end());
        const conn = new IpcConnection(socket);
        this.connections.set(conn.id, conn);
        this.emit('connection', conn);
        const parser = new StreamParser((result) => {
            if (result.ok) {
                // M-3: register agentSessionId mapping on SUBMIT_TASK
                if (result.message.type === 'SUBMIT_TASK') {
                    const sessionId = result.message.payload.agentSessionId;
                    if (sessionId) {
                        this.agentSessionMap.set(sessionId, conn);
                    }
                }
                this.emit('message', result.message, conn);
            }
            else {
                // Send error response but keep connection open
                conn.send(createError(result.error.code, result.error.message));
            }
        });
        const cleanup = () => {
            this.connections.delete(conn.id);
            // M-3: clean up agentSessionMap on disconnect
            for (const [sessionId, c] of this.agentSessionMap) {
                if (c === conn) {
                    this.agentSessionMap.delete(sessionId);
                }
            }
            parser.reset();
        };
        socket.on('data', (chunk) => parser.push(chunk));
        socket.on('close', cleanup);
        socket.on('error', cleanup);
    }
    /**
     * Start listening. Removes stale socket file if exists.
     */
    listen() {
        return new Promise((resolve, reject) => {
            // Remove existing socket file
            try {
                if (fs.existsSync(this.options.socketPath)) {
                    fs.unlinkSync(this.options.socketPath);
                }
            }
            catch {
                // Ignore
            }
            this.server.listen(this.options.socketPath, () => {
                // Set socket permissions
                try {
                    fs.chmodSync(this.options.socketPath, this.options.mode ?? 0o660);
                }
                catch {
                    // Non-fatal in test environments
                }
                // M-4: Set group ownership to openclaw-agent
                this._chownSocketToOpenclaw();
                resolve();
            });
            this.server.once('error', reject);
        });
    }
    /**
     * Attempts to set socket file group ownership to 'openclaw-agent'.
     * Non-fatal: logs a warning if group does not exist or chown fails.
     */
    _chownSocketToOpenclaw() {
        const socketPath = this.options.socketPath;
        try {
            // Try to resolve GID by parsing /etc/group
            const gid = this._resolveGroupGid('openclaw-agent');
            if (gid === null) {
                console.warn('[IpcServer] Warning: group "openclaw-agent" not found; skipping chown');
                return;
            }
            // uid -1 means "don't change uid" on some platforms; use process.getuid() or 0 for root
            // chownSync(path, uid, gid): pass -1 to leave uid unchanged (Node.js supports -1)
            fs.chownSync(socketPath, -1, gid);
        }
        catch (err) {
            console.warn('[IpcServer] Warning: failed to chown socket to openclaw-agent:', err);
        }
    }
    /**
     * Resolves the GID of a group by parsing /etc/group.
     * Returns null if group is not found or file is unreadable.
     */
    _resolveGroupGid(groupName) {
        try {
            const content = fs.readFileSync('/etc/group', 'utf8');
            for (const line of content.split('\n')) {
                const parts = line.split(':');
                if (parts[0] === groupName && parts.length >= 3) {
                    const gid = parseInt(parts[2], 10);
                    if (!isNaN(gid))
                        return gid;
                }
            }
            return null;
        }
        catch {
            // Fallback: try execSync chown
            try {
                execSync(`chown root:${groupName} ${this.options.socketPath}`, { stdio: 'ignore' });
                return null; // Already done via execSync, return null to skip fs.chownSync
            }
            catch {
                return null;
            }
        }
    }
    /**
     * Send a message to a specific agentSessionId (M-1).
     * Returns true if the connection exists and is active, false otherwise.
     */
    send(sessionId, message) {
        const conn = this.agentSessionMap.get(sessionId);
        if (conn && !conn.destroyed) {
            conn.send(message);
            return true;
        }
        return false;
    }
    /**
     * Check if the connection for a given agentSessionId is active (M-2).
     */
    isActive(sessionId) {
        const conn = this.agentSessionMap.get(sessionId);
        return conn !== undefined && !conn.destroyed;
    }
    /**
     * Broadcast a message to all connections.
     */
    broadcast(message) {
        for (const conn of this.connections.values()) {
            conn.send(message);
        }
    }
    /**
     * Close the server and all connections.
     */
    close() {
        return new Promise((resolve) => {
            for (const conn of this.connections.values()) {
                conn.close();
            }
            this.connections.clear();
            this.agentSessionMap.clear();
            this.server.close(() => {
                try {
                    if (fs.existsSync(this.options.socketPath)) {
                        fs.unlinkSync(this.options.socketPath);
                    }
                }
                catch {
                    // Ignore
                }
                resolve();
            });
        });
    }
    get connectionCount() {
        return this.connections.size;
    }
}
//# sourceMappingURL=server.js.map