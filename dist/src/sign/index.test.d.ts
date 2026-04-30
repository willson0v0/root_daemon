/**
 * Unit tests for Token & Sign module
 *
 * Covers:
 *   SIGN-01: Normal generate + verify passes (no exception)
 *   SIGN-02: Tampered token → TokenInvalidError
 *   SIGN-03: Replay attack (second consume) → TokenAlreadyConsumedError
 *   SIGN-04: Expired token → TokenExpiredError
 *   Extra:   loadConsumed() persists across restart simulation
 */
export {};
//# sourceMappingURL=index.test.d.ts.map