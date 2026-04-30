/**
 * Message framing: 4-byte Big-Endian uint32 length prefix + JSON payload
 * Implements §3.2.2 message frame format
 */
export declare const MAX_MESSAGE_SIZE: number;
export declare const HEADER_SIZE = 4;
/**
 * Encode a message object into a framed buffer.
 * Layout: [uint32 BE length][JSON UTF-8 bytes]
 */
export declare function encodeMessage(msg: unknown): Buffer;
/**
 * Read a uint32 BE length from buffer at offset.
 */
export declare function readLength(buf: Buffer, offset?: number): number;
//# sourceMappingURL=framing.d.ts.map