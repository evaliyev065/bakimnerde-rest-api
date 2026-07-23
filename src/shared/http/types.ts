import type { Request } from "express";

export interface RequestContext {
  readonly requestId: string;
  readonly apiVersion: string;
}

export type ContextRequest = Request & { context: RequestContext };

export interface ResponseMeta {
  readonly requestId: string;
  readonly apiVersion: string;
}

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: ReadonlyArray<{ readonly field: string; readonly reason: string }>;
    readonly retryable: boolean;
  };
  readonly meta: ResponseMeta;
}
