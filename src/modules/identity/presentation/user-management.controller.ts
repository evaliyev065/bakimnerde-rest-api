import type { Request, Response } from "express";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { AuditService } from "../application/audit.service.js";
import type { UserManagementService } from "../application/user-management.service.js";
import type { TenantType } from "../domain/identity.types.js";
import type { AuthenticatedResponse } from "./auth.middleware.js";

export class UserManagementController {
  public constructor(private readonly service: UserManagementService, private readonly audit: AuditService) {}
  public listPlatform = this.list("PLATFORM");
  public listCpo = this.list("CPO");
  public listContractor = this.list("CONTRACTOR");
  public create = this.mutation("USER_CREATED", (request, principal) => this.service.create(principal, request.body));
  public update = this.mutation("USER_UPDATED", (request, principal) => this.service.update(principal, request.body));
  public delete = this.mutation("USER_DELETED", (request, principal) => this.service.delete(principal, (request.body as { id?: string }).id ?? ""));

  private list(type: TenantType) {
    return async (request: Request, response: Response): Promise<void> => {
      const data = await this.service.list((response as AuthenticatedResponse).locals.auth, type);
      response.json(success(request as ContextRequest, data));
    };
  }

  private mutation(action: string, handler: (request: Request, principal: AuthenticatedResponse["locals"]["auth"]) => Promise<Record<string, unknown>>) {
    return async (request: Request, response: Response): Promise<void> => {
      const principal = (response as AuthenticatedResponse).locals.auth;
      const data = await handler(request, principal);
      await this.audit.record({
        principal, action, resourceType: "user", resourceId: String(data.id ?? "unknown"),
        requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown",
        payload: { fields: Object.keys(request.body as object).filter(key => !["password"].includes(key)) },
      });
      response.json(success(request as ContextRequest, data));
    };
  }
}
