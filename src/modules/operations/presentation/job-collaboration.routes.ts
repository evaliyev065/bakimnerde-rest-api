import type { AppConfig } from "../../../config/env.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "../../identity/presentation/auth.middleware.js";
import type { JobCollaborationController } from "./job-collaboration.controller.js";

export function registerJobCollaborationRoutes(routes: RouteRegistry, controller: JobCollaborationController, config: AppConfig): void {
  const auth = authenticate(config);
  routes.post("/job-evidence-list", auth, controller.listEvidence);
  routes.post("/job-evidence-download", auth, controller.downloadEvidence);
  routes.post("/job-evidence-add", auth, controller.addEvidence);
  routes.post("/job-field-report-get", auth, controller.getFieldReport);
  routes.post("/job-field-report-save", auth, controller.saveFieldReport);
  routes.post("/additional-requests-list", auth, controller.listRequests);
  routes.post("/additional-requests-create", auth, controller.createRequest);
  routes.post("/additional-requests-price", auth, controller.priceRequest);
  routes.post("/additional-requests-deadline", auth, controller.setRequestDeadline);
  routes.post("/additional-requests-update", auth, controller.updateRequest);
  routes.post("/job-messages-list", auth, controller.listMessages);
  routes.post("/job-messages-send", auth, controller.sendMessage);
}
