import type { Request, Response } from "express";
import type { AuditService } from "../application/audit.service.js";
import type {
  ContractorRegistrationInput,
  ContractorRegistrationService,
} from "../application/contractor-registration.service.js";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { AuthenticatedResponse } from "./auth.middleware.js";

export class ContractorRegistrationController {
  public constructor(
    private readonly service: ContractorRegistrationService,
    private readonly audit: AuditService,
  ) {}

  public submit = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.submit(request.body as ContractorRegistrationInput);
    response.status(201).json(success(request as ContextRequest, data));
  };

  public list = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.list((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };

  public approve = async (request: Request, response: Response): Promise<void> => {
    const principal = (response as AuthenticatedResponse).locals.auth;
    const data = await this.service.approve(principal, String((request.body as { id?: string }).id ?? ""));
    await this.audit.record({
      principal,
      action: "CONTRACTOR_APPLICATION_APPROVED",
      resourceType: "contractorApplication",
      resourceId: data.id,
      requestId: (request as ContextRequest).context.requestId,
      ipAddress: request.ip ?? "unknown",
      payload: { tenantId: data.tenantId, tenantKey: data.tenantKey },
    });
    response.json(success(request as ContextRequest, data));
  };

  public reject = async (request: Request, response: Response): Promise<void> => {
    const principal = (response as AuthenticatedResponse).locals.auth;
    const body = request.body as { id?: string; reason?: string };
    const data = await this.service.reject(principal, String(body.id ?? ""), String(body.reason ?? ""));
    await this.audit.record({
      principal,
      action: "CONTRACTOR_APPLICATION_REJECTED",
      resourceType: "contractorApplication",
      resourceId: data.id,
      requestId: (request as ContextRequest).context.requestId,
      ipAddress: request.ip ?? "unknown",
      payload: { reason: body.reason ?? "" },
    });
    response.json(success(request as ContextRequest, data));
  };
}
