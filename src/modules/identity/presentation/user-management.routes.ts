import type { AppConfig } from "../../../config/env.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "./auth.middleware.js";
import type { UserManagementController } from "./user-management.controller.js";

export function registerUserManagementRoutes(routes: RouteRegistry, controller: UserManagementController, config: AppConfig): void {
  const auth = authenticate(config);
  routes.get("/users-platform-list", auth, controller.listPlatform);
  routes.get("/users-cpo-list", auth, controller.listCpo);
  routes.get("/users-contractor-list", auth, controller.listContractor);
  routes.post("/users-create", auth, controller.create);
  routes.post("/users-update", auth, controller.update);
  routes.post("/users-delete", auth, controller.delete);
}
