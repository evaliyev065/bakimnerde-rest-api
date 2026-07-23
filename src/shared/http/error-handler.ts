import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { failure } from "./response.js";
import type { ContextRequest } from "./types.js";

export const rejectQueryString: RequestHandler = (request, _response, next): void => {
  if (request.originalUrl.includes("?")) {
    next(new AppError(
      400,
      "URL_PARAMETERS_NOT_ALLOWED",
      "URL üzerinde query parametresi kullanılamaz; gerekli verileri request body içinde gönderin.",
      false,
      [{ field: "url", reason: "query_parameters_are_forbidden" }]
    ));
    return;
  }
  next();
};

export const notFoundHandler: RequestHandler = (_request, _response, next): void => {
  next(new AppError(
    404,
    "ENDPOINT_NOT_FOUND",
    "İstenen endpoint bulunamadı.",
    false,
    [{ field: "url", reason: "unknown_static_endpoint" }]
  ));
};

const UNSUPPORTED_BUSINESS_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

export const rejectUnsupportedBusinessMethod: RequestHandler = (request, response, next): void => {
  if (!UNSUPPORTED_BUSINESS_METHODS.has(request.method)) {
    next();
    return;
  }

  response.setHeader("allow", "GET, POST");
  next(new AppError(
    405,
    "API_METHOD_NOT_ALLOWED",
    "Bu API yöntemine izin verilmez; iş işlemlerini statik POST endpoint'i ve JSON body ile gönderin.",
    false,
    [{ field: "method", reason: "use_static_post_endpoint" }]
  ));
};

export const errorHandler: ErrorRequestHandler = (error, request, response, _next): void => {
  const contextRequest = request as ContextRequest;
  const knownError = error instanceof AppError;
  const invalidJson = error instanceof SyntaxError && "body" in error;
  const statusCode = knownError ? error.statusCode : invalidJson ? 400 : 500;
  const code = knownError ? error.code : invalidJson ? "INVALID_JSON_BODY" : "INTERNAL_ERROR";
  const message = knownError
    ? error.message
    : invalidJson
      ? "Request body geçerli JSON biçiminde olmalıdır."
      : "Beklenmeyen bir hata oluştu.";

  response.status(statusCode).json(failure(contextRequest, {
    code,
    message,
    details: knownError ? error.details : [],
    retryable: knownError ? error.retryable : false
  }));
};
