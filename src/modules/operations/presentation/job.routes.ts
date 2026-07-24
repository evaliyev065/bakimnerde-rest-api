import type { AppConfig } from "../../../config/env.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "../../identity/presentation/auth.middleware.js";
import type { JobController } from "./job.controller.js";

export function registerJobRoutes(routes: RouteRegistry, controller: JobController, config: AppConfig): void {
  routes.get("/jobs-list", authenticate(config), controller.list);
  routes.post("/jobs-create", authenticate(config), controller.create);
  routes.post("/jobs-update", authenticate(config), controller.update);
  routes.post("/jobs-status-change", authenticate(config), controller.changeStatus);
  routes.post("/jobs-delete", authenticate(config), controller.delete);
}
