import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import type { HealthController } from "./health.controller.js";

export function registerHealthRoutes(
  routes: RouteRegistry,
  controller: HealthController
): void {
  routes.get("/health-live", controller.live);
  routes.get("/health-ready", controller.ready);
}
