import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../../config/env.js";
import type { ContextRequest } from "./types.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestContext(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const suppliedRequestId = request.header("x-request-id");
    const requestId = suppliedRequestId !== undefined && SAFE_REQUEST_ID.test(suppliedRequestId)
      ? suppliedRequestId
      : `req_${randomUUID()}`;

    (request as ContextRequest).context = { requestId, apiVersion: config.apiVersion };
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-api-version", config.apiVersion);
    next();
  };
}
