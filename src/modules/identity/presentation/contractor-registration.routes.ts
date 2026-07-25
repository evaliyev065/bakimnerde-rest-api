import type { AppConfig } from "../../../config/env.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "./auth.middleware.js";
import type { ContractorRegistrationController } from "./contractor-registration.controller.js";

export function registerContractorRegistrationRoutes(
  routes: RouteRegistry,
  controller: ContractorRegistrationController,
  config: AppConfig,
): void {
  const authenticated = authenticate(config);
  routes.post("/contractor-applications-create", controller.submit);
  routes.get("/contractor-applications-list", authenticated, controller.list);
  routes.post("/contractor-applications-approve", authenticated, controller.approve);
  routes.post("/contractor-applications-reject", authenticated, controller.reject);
}
