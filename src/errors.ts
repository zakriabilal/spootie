/** Shared classification helpers for S3/network errors. */

export const errorName = (err: unknown): string => (err instanceof Error ? err.name : "");

export const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

/** HTTP status from an AWS SDK error's $metadata, if present. */
export const errorStatus = (err: unknown): number | undefined => {
    if (typeof err === "object" && err !== null && "$metadata" in err) {
        const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
        return meta?.httpStatusCode;
    }
    return undefined;
};

export const isBadCredentials = (err: unknown): boolean => {
    const name = errorName(err);
    return (
        name === "InvalidAccessKeyId" ||
        name === "SignatureDoesNotMatch" ||
        errorStatus(err) === 401
    );
};

export const isAccessDenied = (err: unknown): boolean =>
    errorName(err) === "AccessDenied" || errorStatus(err) === 403;

export const isNoLifecycleConfiguration = (err: unknown): boolean =>
    errorName(err) === "NoSuchLifecycleConfiguration" || errorStatus(err) === 404;

/** System/socket error codes that indicate a connectivity problem. */
const NETWORK_ERROR_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    // Bun fetch/socket error codes.
    "ConnectionRefused",
    "ConnectionClosed",
    "FailedToOpenSocket",
    "DNSException",
]);

/**
 * True for failures that retrying can plausibly fix: DNS/socket/timeout
 * errors anywhere in the cause chain, or a 5xx response. Auth and config
 * problems (bad credentials, AccessDenied, NoSuchBucket, ...) return false.
 */
export const isRetryableNetworkError = (err: unknown): boolean => {
    if (isBadCredentials(err) || isAccessDenied(err)) return false;

    const status = errorStatus(err);
    if (status !== undefined && status >= 500) return true;

    // Walk the cause chain: the AWS SDK and fetch both wrap socket errors.
    for (
        let current: unknown = err;
        typeof current === "object" && current !== null;
        current = (current as { cause?: unknown }).cause
    ) {
        const { name, code, message } = current as {
            name?: string;
            code?: string;
            message?: string;
        };

        if (code !== undefined && NETWORK_ERROR_CODES.has(code)) return true;
        if (name === "TimeoutError" || name === "NetworkingError") return true;
        if (
            typeof message === "string" &&
            (/fetch failed|socket|network|timed? ?out/i.test(message) ||
                [...NETWORK_ERROR_CODES].some((c) => message.includes(c)))
        ) {
            return true;
        }
    }

    return false;
};
