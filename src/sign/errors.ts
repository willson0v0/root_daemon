/**
 * Custom error classes for the Token & Sign module
 */

export class TokenExpiredError extends Error {
  constructor(message = 'Token has expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export class TokenInvalidError extends Error {
  constructor(message = 'Token signature is invalid') {
    super(message);
    this.name = 'TokenInvalidError';
  }
}

export class TokenAlreadyConsumedError extends Error {
  constructor(message = 'Token has already been consumed (replay attack detected)') {
    super(message);
    this.name = 'TokenAlreadyConsumedError';
  }
}
