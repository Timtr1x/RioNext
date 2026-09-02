export const ErrorCategory = {
  transient: "transient",
  invalid_observation: "invalid_observation",
  missing_precondition: "missing_precondition",
  denied: "denied",
  inconclusive: "inconclusive",
  uncertain_effect: "uncertain_effect",
  protocol_error: "protocol_error",
  conflict: "conflict",
  invalid_input: "invalid_input",
  budget: "budget",
  cancelled: "cancelled",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export class DomainError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, category: ErrorCategory, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

export function invalidInput(code: string, message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError(code, message, "invalid_input", details);
}

export function denied(code: string, message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError(code, message, "denied", details);
}

export function conflict(code: string, message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError(code, message, "conflict", details);
}
