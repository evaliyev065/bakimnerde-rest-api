import type { Request, Response } from "express";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { AuditService } from "../../identity/application/audit.service.js";
import type { AuthenticatedResponse } from "../../identity/presentation/auth.middleware.js";
import type { JobCollaborationService } from "../application/job-collaboration.service.js";

export class JobCollaborationController {
  public constructor(private readonly service: JobCollaborationService, private readonly audit: AuditService) {}
  public listEvidence = this.query((request, principal) => this.service.listEvidence(principal, this.jobId(request)));
  public addEvidence = this.mutation("JOB_EVIDENCE_ADDED", "jobMedia", (request, principal) => this.service.addEvidence(principal, request.body));
  public getFieldReport = this.query((request, principal) => this.service.getFieldReport(principal, this.jobId(request)));
  public saveFieldReport = this.mutation("JOB_FIELD_REPORT_SAVED", "jobFieldReport", (request, principal) => this.service.saveFieldReport(principal, request.body));
  public listRequests = this.query((request, principal) => this.service.listRequests(principal, this.jobId(request)));
  public createRequest = this.mutation("ADDITIONAL_REQUEST_CREATED", "additionalRequest", (request, principal) => this.service.createRequest(principal, request.body));
  public updateRequest = this.mutation("ADDITIONAL_REQUEST_UPDATED", "additionalRequest", (request, principal) => this.service.updateRequest(principal, request.body));
  public listMessages = this.query((request, principal) => this.service.listMessages(principal, this.jobId(request)));
  public sendMessage = this.mutation("JOB_MESSAGE_SENT", "message", (request, principal) => this.service.sendMessage(principal, request.body));

  private jobId(request: Request) { return (request.body as { jobId?: string }).jobId ?? ""; }
  private query(handler: (request: Request, principal: AuthenticatedResponse["locals"]["auth"]) => Promise<unknown>) {
    return async (request: Request, response: Response) => response.json(success(request as ContextRequest, await handler(request, (response as AuthenticatedResponse).locals.auth)));
  }
  private mutation(action: string, resourceType: string, handler: (request: Request, principal: AuthenticatedResponse["locals"]["auth"]) => Promise<Record<string, unknown>>) {
    return async (request: Request, response: Response): Promise<void> => {
      const principal = (response as AuthenticatedResponse).locals.auth;
      const data = await handler(request, principal);
      await this.audit.record({
        principal, action, resourceType, resourceId: String(data.id ?? "unknown"),
        requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown",
      });
      response.json(success(request as ContextRequest, data));
    };
  }
}
