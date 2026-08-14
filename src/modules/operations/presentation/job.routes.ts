import type { AppConfig } from "../../../config/env.js";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "../../identity/presentation/auth.middleware.js";
import type { JobController } from "./job.controller.js";

export function registerJobRoutes(routes: RouteRegistry, controller: JobController, config: AppConfig, database: MongoDatabase): void {
  const auth = authenticate(config, database);
  routes.get("/jobs-list", auth, controller.list);
  routes.get("/jobs-summary", auth, controller.summary);
  routes.post("/jobs-detail", auth, controller.detail);
  routes.get("/charge-points-list", auth, controller.listChargePoints);
  routes.get("/stations-list", auth, controller.listStations);
  routes.post("/stations-create", auth, controller.createStation);
  routes.post("/charge-points-create", auth, controller.createChargePoint);
  routes.post("/charge-point-maintenance-list", auth, controller.listChargePointMaintenance);
  routes.post("/station-maintenance-list", auth, controller.listStationMaintenance);
  routes.get("/field-workers-list", auth, controller.listFieldWorkers);
  routes.post("/jobs-create", auth, controller.create);
  routes.post("/jobs-update", auth, controller.update);
  routes.post("/jobs-assign", auth, controller.assignContractor);
  routes.post("/jobs-appointment-update", auth, controller.updateAppointment);
  routes.post("/jobs-given-duration-update", auth, controller.updateGivenDuration);
  routes.post("/jobs-cpo-review", auth, controller.reviewByCpo);
  routes.post("/jobs-status-change", auth, controller.changeStatus);
  routes.post("/jobs-assignment-accept", auth, controller.acceptAssignment);
  routes.post("/jobs-field-worker-assign", auth, controller.assignFieldWorker);
  routes.post("/jobs-payment-cpo", auth, controller.payCpoInvoice);
  routes.post("/jobs-payment-contractor", auth, controller.payContractor);
  routes.post("/jobs-delete", auth, controller.delete);
}
