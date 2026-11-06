/**
 * Sanitizes sensitive information (tokens, authorization headers, cookies, passwords) from strings.
 */
export function sanitizeSecret(input: string): string {
  if (!input) return input;
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(MATTERMOST_TOKEN\s*=\s*)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)(["']?)[A-Za-z0-9_-]+(["']?)/gi, '$1[REDACTED]')
    .replace(/(MMAUTHTOKEN\s*=\s*)([A-Za-z0-9_-]+)/gi, '$1[REDACTED]')
    .replace(/(MMCSRF\s*=\s*)([A-Za-z0-9_-]+)/gi, '$1[REDACTED]')
    .replace(/(X-CSRF-Token\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(password\s*[:=]\s*)(["']?)[^\s"',]+(["']?)/gi, '$1[REDACTED]');
}

export interface MattermostErrorOptions {
  code: string;
  statusCode?: number;
  isRetryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class MattermostError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;
  public readonly isRetryable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, options: MattermostErrorOptions) {
    super(sanitizeSecret(message));
    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.isRetryable = options.isRetryable ?? false;
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class MattermostAuthenticationError extends MattermostError {
  constructor(
    message = 'Mattermost authentication failed or session expired. Please log in using "npm run cli -- login".',
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, {
      code: 'AUTHENTICATION_FAILED',
      statusCode: 401,
      isRetryable: false,
      details,
      cause,
    });
  }
}

export class MattermostAuthorizationError extends MattermostError {
  constructor(message = 'Mattermost authorization failed. Insufficient permissions.', details?: Record<string, unknown>, cause?: unknown) {
    super(message, {
      code: 'FORBIDDEN',
      statusCode: 403,
      isRetryable: false,
      details,
      cause,
    });
  }
}

export class MattermostChannelNotFoundError extends MattermostError {
  constructor(channelIdentifier: string, details?: Record<string, unknown>, cause?: unknown) {
    super(`Mattermost channel '${channelIdentifier}' was not found.`, {
      code: 'CHANNEL_NOT_FOUND',
      statusCode: 404,
      isRetryable: false,
      details: { channelIdentifier, ...details },
      cause,
    });
  }
}

export class MattermostChannelDisabledError extends MattermostError {
  constructor(channelIdentifier: string, details?: Record<string, unknown>) {
    super(
      `Mattermost channel '${channelIdentifier}' is disabled in channels.yml configuration. Set 'enabled: true' to allow sending messages.`,
      {
        code: 'CHANNEL_DISABLED',
        statusCode: 403,
        isRetryable: false,
        details: { channelIdentifier, ...details },
      }
    );
  }
}

export class MattermostRateLimitError extends MattermostError {
  public readonly retryAfterMs: number;

  constructor(message = 'Mattermost rate limit exceeded.', retryAfterMs = 5000, details?: Record<string, unknown>, cause?: unknown) {
    super(message, {
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      isRetryable: true,
      details: { retryAfterMs, ...details },
      cause,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export class MattermostNetworkError extends MattermostError {
  constructor(message = 'Network error communicating with Mattermost.', statusCode?: number, details?: Record<string, unknown>, cause?: unknown) {
    super(message, {
      code: 'NETWORK_ERROR',
      statusCode: statusCode ?? 503,
      isRetryable: true,
      details,
      cause,
    });
  }
}

export class MattermostValidationError extends MattermostError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      isRetryable: false,
      details,
      cause,
    });
  }
}

export class MattermostIdentityMismatchError extends MattermostError {
  constructor(expectedUserId: string, actualUserId: string, details?: Record<string, unknown>) {
    super(
      `Authenticated user ID '${actualUserId}' does not match expected user ID '${expectedUserId}'.`,
      {
        code: 'IDENTITY_MISMATCH',
        statusCode: 403,
        isRetryable: false,
        details: { expectedUserId, actualUserId, ...details },
      }
    );
  }
}

export class MattermostProviderError extends MattermostError {
  constructor(message: string, code = 'PROVIDER_ERROR', details?: Record<string, unknown>, cause?: unknown) {
    super(message, {
      code,
      statusCode: 500,
      isRetryable: false,
      details,
      cause,
    });
  }
}
