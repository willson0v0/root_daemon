/**
 * Message framing: 4-byte Big-Endian uint32 length prefix + JSON payload
 * Implements §3.2.2 message frame format
 */
export const MAX_MESSAGE_SIZE = 1024 * 1024; // 1 MB
export const HEADER_SIZE = 4; // 4 bytes for uint32 length
/**
 * Encode a message object into a framed buffer.
 * Layout: [uint32 BE length][JSON UTF-8 bytes]
 */
export function encodeMessage(msg) {
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, 'utf8');
    const header = Buffer.allocUnsafe(HEADER_SIZE);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
}
/**
 * Read a uint32 BE length from buffer at offset.
 */
export function readLength(buf, offset = 0) {
    return buf.readUInt32BE(offset);
}
//# sourceMappingURL=framing.js.map