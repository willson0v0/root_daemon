/**
 * Streaming message parser - handles TCP fragmentation (粘包/半包)
 * Implements §3.2.2 framing protocol
 */
import type { IpcMessage, ErrorCode } from './types.js';
export type ParseResult = {
    ok: true;
    message: IpcMessage;
} | {
    ok: false;
    error: {
        code: ErrorCode;
        message: string;
    };
};
/**
 * StreamParser maintains a byte buffer and emits complete messages.
 * Call push(chunk) to feed data; it calls onMessage for each complete frame.
 */
export declare class StreamParser {
    private readonly onMessage;
    private buffer;
    constructor(onMessage: (result: ParseResult) => void);
    /**
     * Feed a new chunk of data into the parser.
     */
    push(chunk: Buffer): void;
    private processBuffer;
    /**
     * Reset the internal buffer (e.g., on connection close).
     */
    reset(): void;
}
//# sourceMappingURL=parser.d.ts.map