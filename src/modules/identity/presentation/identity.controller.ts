import type { Request, Response } from "express";
import type { AuthService } from "../application/auth.service.js";
import type { AuditService } from "../application/audit.service.js";
import type { CreateTenantInput, TenantService, UpdateTenantInput } from "../application/tenant.service.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import { success } from "../../../shared/http/response.js";
import type { AuthenticatedResponse } from "./auth.middleware.js";

export class IdentityController {
  public constructor(
    private readonly authService: AuthService,
    private readonly tenantService: TenantService,
    private readonly auditService: AuditService,
  ) {}

  public platformLogin = async (request: Request, response: Response): Promise<void> => {
    const body = request.body as { email?: string; password?: string };
    const result = await this.authService.platformLogin(body.email ?? "", body.password ?? "");
    await this.recordLogin(request, result.principal, "PLATFORM");
    response.json(success(request as ContextRequest, result));
  };

  public companyLogin = async (request: Request, response: Response): Promise<void> => {
    const body = request.body as { email?: string; password?: string };
    const result = await this.authService.companyLogin(body.email ?? "", body.password ?? "");
    await this.recordLogin(request, result.principal, "COMPANY");
    response.json(success(request as ContextRequest, result));
  };

  public fieldLogin = async (request: Request, response: Response): Promise<void> => {
    const body = request.body as { email?: string; password?: string };
    const result = await this.authService.fieldLogin(body.email ?? "", body.password ?? "");
    await this.recordLogin(request, result.principal, "FIELD");
    response.json(success(request as ContextRequest, result));
  };

  private async recordLogin(request: Request, principal: AuthenticatedResponse["locals"]["auth"], channel: string): Promise<void> {
    await this.auditService.record({
      principal,
      action: "AUTH_LOGIN_SUCCEEDED",
      resourceType: "session",
      resourceId: principal.userId,
      requestId: (request as ContextRequest).context.requestId,
      ipAddress: request.ip ?? "unknown",
      payload: { channel },
    });
  }

  public me = (request: Request, response: Response): void => {
    response.json(success(request as ContextRequest, (response as AuthenticatedResponse).locals.auth));
  };

  public listTenants = async (request: Request, response: Response): Promise<void> => {
    const data = await this.tenantService.list((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };
  public ownTenantProfile = async (request: Request, response: Response): Promise<void> => {
    const data = await this.tenantService.ownProfile((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };
  public updateOwnCoverage = async (request: Request, response: Response): Promise<void> => {
    const principal = (response as AuthenticatedResponse).locals.auth;
    const data = await this.tenantService.updateOwnCoverage(principal, request.body as { serviceRegions: string[]; activityAreas: string[] });
    await this.auditService.record({ principal, action: "CONTRACTOR_COVERAGE_UPDATED", resourceType: "tenant", resourceId: data.id, requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown" });
    response.json(success(request as ContextRequest, data));
  };

  public createTenant = async (request: Request, response: Response): Promise<void> => {
    const principal = (response as AuthenticatedResponse).locals.auth;
    const data = await this.tenantService.create(principal, request.body as CreateTenantInput);
    await this.auditService.record({
      principal,
      action: "TENANT_CREATED",
      resourceType: "tenant",
      resourceId: data.id,
      requestId: (request as ContextRequest).context.requestId,
      ipAddress: request.ip ?? "unknown",
      payload: { tenantKey: data.tenantKey },
    });
    response.status(201).json(success(request as ContextRequest, data));
  };

  public updateTenant = async (request: Request, response: Response): Promise<void> => {
    const principal = (response as AuthenticatedResponse).locals.auth;
    const data = await this.tenantService.update(principal, request.body as UpdateTenantInput);
    await this.auditService.record({
      principal, action: "TENANT_UPDATED", resourceType: "tenant", resourceId: data.id,
      requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown",
      payload: { fields: Object.keys(request.body as object).filter(key => key !== "adminPassword") },
    });
    response.json(success(request as ContextRequest, data));
  };

  public deleteTenant = async (request: Request, response: Response): Promise<void> => {
    const principal = (response as AuthenticatedResponse).locals.auth;
    const body = request.body as { id?: string };
    const data = await this.tenantService.delete(principal, body.id ?? "");
    await this.auditService.record({
      principal, action: "TENANT_DELETED", resourceType: "tenant", resourceId: data.id,
      requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown",
    });
    response.json(success(request as ContextRequest, data));
  };

  public listAuditLogs = async (request: Request, response: Response): Promise<void> => {
    const data = await this.auditService.list((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };
}
