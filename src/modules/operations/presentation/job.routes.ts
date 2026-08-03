import type { AppConfig } from "../../../config/env.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "../../identity/presentation/auth.middleware.js";
import type { JobController } from "./job.controller.js";

export function registerJobRoutes(routes: RouteRegistry, controller: JobController, config: AppConfig): void {
  routes.get("/jobs-list", authenticate(config), controller.list);
  routes.get("/jobs-summary", authenticate(config), controller.summary);
  routes.get("/charge-points-list", authenticate(config), controller.listChargePoints);
  routes.get("/stations-list", authenticate(config), controller.listStations);
  routes.post("/charge-point-maintenance-list", authenticate(config), controller.listChargePointMaintenance);
  routes.post("/station-maintenance-list", authenticate(config), controller.listStationMaintenance);
  routes.get("/field-workers-list", authenticate(config), controller.listFieldWorkers);
  routes.post("/jobs-create", authenticate(config), controller.create);
  routes.post("/jobs-update", authenticate(config), controller.update);
  routes.post("/jobs-status-change", authenticate(config), controller.changeStatus);
  routes.post("/jobs-assignment-accept", authenticate(config), controller.acceptAssignment);
  routes.post("/jobs-field-worker-assign", authenticate(config), controller.assignFieldWorker);
  routes.post("/jobs-payment-cpo", authenticate(config), controller.payCpoInvoice);
  routes.post("/jobs-payment-contractor", authenticate(config), controller.payContractor);
  routes.post("/jobs-delete", authenticate(config), controller.delete);
}
