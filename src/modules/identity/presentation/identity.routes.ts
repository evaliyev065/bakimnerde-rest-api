import type { AppConfig } from "../../../config/env.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import type { IdentityController } from "./identity.controller.js";
import { authenticate } from "./auth.middleware.js";

export function registerIdentityRoutes(routes: RouteRegistry, controller: IdentityController, config: AppConfig): void {
  const authenticated = authenticate(config);
  routes.post("/auth-platform-login", controller.platformLogin);
  routes.post("/auth-company-login", controller.companyLogin);
  routes.post("/auth-field-login", controller.fieldLogin);
  routes.get("/auth-me", authenticated, controller.me);
  routes.get("/tenants-list", authenticated, controller.listTenants);
  routes.get("/tenant-profile", authenticated, controller.ownTenantProfile);
  routes.post("/tenant-coverage-update", authenticated, controller.updateOwnCoverage);
  routes.post("/tenants-create", authenticated, controller.createTenant);
  routes.post("/tenants-update", authenticated, controller.updateTenant);
  routes.post("/tenants-delete", authenticated, controller.deleteTenant);
  routes.get("/audit-logs", authenticated, controller.listAuditLogs);
}
