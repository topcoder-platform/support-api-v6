const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{0,95}$/;
const SAFE_TRANSPORT_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A keyed object used while safely inspecting unknown integration failures. */
type UnknownRecord = Record<string, unknown>;

/**
 * Represents an external integration failure using only a bounded, non-PII
 * diagnostic code. The original provider message and response body are never
 * copied into the error, logs, or notification outbox.
 */
export class IntegrationDeliveryError extends Error {
  readonly safeCode: string;

  /**
   * Creates a sanitized integration error.
   *
   * @param safeCode bounded machine-readable failure code.
   */
  constructor(safeCode: string) {
    super('External integration request failed.');
    this.name = IntegrationDeliveryError.name;
    this.safeCode = SAFE_FAILURE_CODE.test(safeCode)
      ? safeCode
      : 'unclassified';
  }
}

/**
 * Converts an unknown HTTP, SDK, or integration error into a safe diagnostic
 * code. Only a previously sanitized code, numeric HTTP status, or constrained
 * transport code is retained; arbitrary messages and response bodies are ignored.
 *
 * @param error unknown failure raised by an integration.
 * @returns a bounded code safe for structured logs and the outbox `lastError` field.
 */
export function safeIntegrationFailureCode(error: unknown): string {
  if (error instanceof IntegrationDeliveryError) {
    return error.safeCode;
  }
  const record = asRecord(error);
  if (!record) {
    return 'unclassified';
  }

  const status = firstHttpStatus(
    record['status'],
    record['statusCode'],
    asRecord(record['response'])?.['status'],
  );
  if (status !== undefined) {
    return `http_${status}`;
  }

  const transportCode = record['code'];
  if (
    typeof transportCode === 'string' &&
    SAFE_TRANSPORT_CODE.test(transportCode)
  ) {
    return `transport_${transportCode.toLowerCase()}`;
  }
  return 'unclassified';
}

/**
 * Wraps an unknown failure with an integration-stage prefix and a sanitized
 * cause code, preserving useful operational context without provider content.
 *
 * @param integration stable integration or request-stage name.
 * @param error unknown original failure.
 * @returns a sanitized error suitable for the notification outbox.
 */
export function integrationDeliveryError(
  integration: string,
  error: unknown,
): IntegrationDeliveryError {
  const normalizedIntegration = integration.trim().toLowerCase();
  const prefix = SAFE_FAILURE_CODE.test(normalizedIntegration)
    ? normalizedIntegration
    : 'integration';
  return new IntegrationDeliveryError(
    `${prefix}_${safeIntegrationFailureCode(error)}`,
  );
}

/**
 * Safely tags a provider-declared, enum-like error code with its integration.
 *
 * @param integration stable integration name.
 * @param providerCode provider error code, never a free-form message.
 * @returns a sanitized integration error.
 */
export function providerDeliveryError(
  integration: string,
  providerCode: unknown,
): IntegrationDeliveryError {
  const normalizedProviderCode =
    typeof providerCode === 'string' ? providerCode.trim().toLowerCase() : '';
  const safeProviderCode = SAFE_FAILURE_CODE.test(normalizedProviderCode)
    ? normalizedProviderCode
    : 'rejected';
  return integrationDeliveryError(
    integration,
    new IntegrationDeliveryError(safeProviderCode),
  );
}

/**
 * Narrows a value to a keyed object without trusting prototypes or fields.
 *
 * @param value candidate unknown value.
 * @returns the keyed object, or undefined for primitives and arrays.
 */
function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

/**
 * Returns the first valid HTTP status from common client error locations.
 *
 * @param values candidate status values.
 * @returns an integer HTTP status, or undefined when none is usable.
 */
function firstHttpStatus(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599,
  );
}
