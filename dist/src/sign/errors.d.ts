/**
 * Custom error classes for the Token & Sign module
 */
export declare class TokenExpiredError extends Error {
    constructor(message?: string);
}
export declare class TokenInvalidError extends Error {
    constructor(message?: string);
}
export declare class TokenAlreadyConsumedError extends Error {
    constructor(message?: string);
}
//# sourceMappingURL=errors.d.ts.map