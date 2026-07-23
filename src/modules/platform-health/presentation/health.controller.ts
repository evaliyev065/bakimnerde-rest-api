import type { RequestHandler } from "express";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { HealthService } from "../application/health.service.js";

export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  public readonly live: RequestHandler = (request, response): void => {
    response.status(200).json(success(request as ContextRequest, this.healthService.getLiveness()));
  };

  public readonly ready: RequestHandler = (request, response): void => {
    response.status(200).json(success(request as ContextRequest, this.healthService.getReadiness()));
  };
}
