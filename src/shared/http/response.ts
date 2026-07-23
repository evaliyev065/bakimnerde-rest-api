import type { ContextRequest, ErrorEnvelope, SuccessEnvelope } from "./types.js";

export function success<T>(request: ContextRequest, data: T): SuccessEnvelope<T> {
  return { data, meta: request.context };
}

export function failure(request: ContextRequest, error: ErrorEnvelope["error"]): ErrorEnvelope {
  return { error, meta: request.context };
}
