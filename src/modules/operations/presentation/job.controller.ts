import type { Request, Response } from "express";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { AuditService } from "../../identity/application/audit.service.js";
import type { AuthenticatedResponse } from "../../identity/presentation/auth.middleware.js";
import type { JobQueryService } from "../application/job-query.service.js";

export class JobController {
  public constructor(private readonly service: JobQueryService, private readonly audit: AuditService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.list((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };
  public listFieldWorkers = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.listFieldWorkers((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };

  public create = this.mutation("JOB_CREATED", (request, principal) => this.service.create(principal, request.body));
  public update = this.mutation("JOB_UPDATED", (request, principal) => this.service.update(principal, request.body));
  public changeStatus = this.mutation("JOB_STATUS_CHANGED", (request, principal) => this.service.changeStatus(principal, request.body));
  public acceptAssignment = this.mutation("JOB_ASSIGNMENT_ACCEPTED", (request, principal) => this.service.acceptAssignment(principal, request.body));
  public assignFieldWorker = this.mutation("FIELD_WORKER_ASSIGNED", (request, principal) => this.service.assignFieldWorker(principal, request.body));
  public delete = this.mutation("JOB_DELETED", (request, principal) => this.service.delete(principal, (request.body as { id?: string }).id ?? ""));

  private mutation(action: string, handler: (request: Request, principal: AuthenticatedResponse["locals"]["auth"]) => Promise<Record<string, unknown>>) {
    return async (request: Request, response: Response): Promise<void> => {
      const principal = (response as AuthenticatedResponse).locals.auth;
      const data = await handler(request, principal);
      const resourceId = String(data.id ?? data.jobNumber ?? "unknown");
      await this.audit.record({
        principal, action, resourceType: "job", resourceId,
        requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown",
        payload: { request: request.body as Record<string, unknown> },
      });
      response.json(success(request as ContextRequest, data));
    };
  }
}
