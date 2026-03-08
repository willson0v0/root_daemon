/**
 * Streaming message parser - handles TCP fragmentation (粘包/半包)
 * Implements §3.2.2 framing protocol
 */
import { HEADER_SIZE, MAX_MESSAGE_SIZE, readLength } from './framing.js';
/**
 * StreamParser maintains a byte buffer and emits complete messages.
 * Call push(chunk) to feed data; it calls onMessage for each complete frame.
 */
export class StreamParser {
    onMessage;
    buffer = Buffer.alloc(0);
    constructor(onMessage) {
        this.onMessage = onMessage;
    }
    /**
     * Feed a new chunk of data into the parser.
     */
    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
    }
    processBuffer() {
        while (true) {
            // Need at least 4 bytes for the header
            if (this.buffer.length < HEADER_SIZE)
                break;
            const length = readLength(this.buffer, 0);
            // Validate length
            if (length === 0) {
                // Zero-length message: emit error, discard header, continue
                this.buffer = this.buffer.subarray(HEADER_SIZE);
                this.onMessage({
                    ok: false,
                    error: { code: 'INVALID_MESSAGE', message: 'Zero-length message is not allowed' },
                });
                continue;
            }
            if (length > MAX_MESSAGE_SIZE) {
                // Oversized message: emit error, discard header
                // We can't skip the body since we don't know where it ends without length bytes
                // Discard just the header; caller must close connection or drain
                this.buffer = this.buffer.subarray(HEADER_SIZE);
                this.onMessage({
                    ok: false,
                    error: { code: 'INVALID_MESSAGE', message: `Message size ${length} exceeds limit ${MAX_MESSAGE_SIZE}` },
                });
                // We cannot reliably recover position in stream; clear buffer to avoid cascading errors
                this.buffer = Buffer.alloc(0);
                break;
            }
            // Check if full payload is available
            const totalSize = HEADER_SIZE + length;
            if (this.buffer.length < totalSize)
                break;
            // Extract payload
            const payloadBuf = this.buffer.subarray(HEADER_SIZE, totalSize);
            this.buffer = this.buffer.subarray(totalSize);
            // Parse JSON
            let msg;
            try {
                msg = JSON.parse(payloadBuf.toString('utf8'));
            }
            catch {
                this.onMessage({
                    ok: false,
                    error: { code: 'INVALID_MESSAGE', message: 'Invalid JSON payload' },
                });
                continue;
            }
            // Basic structural validation
            if (!isIpcMessage(msg)) {
                this.onMessage({
                    ok: false,
                    error: { code: 'INVALID_MESSAGE', message: 'Message missing required fields ($schema, type, payload)' },
                });
                continue;
            }
            this.onMessage({ ok: true, message: msg });
        }
    }
    /**
     * Reset the internal buffer (e.g., on connection close).
     */
    reset() {
        this.buffer = Buffer.alloc(0);
    }
}
function isIpcMessage(v) {
    if (typeof v !== 'object' || v === null)
        return false;
    const obj = v;
    return (typeof obj['$schema'] === 'string' &&
        typeof obj['type'] === 'string' &&
        obj['payload'] !== undefined);
}
//# sourceMappingURL=parser.js.map