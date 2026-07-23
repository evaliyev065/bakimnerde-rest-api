import { HealthService } from "../modules/platform-health/application/health.service.js";
import { HealthController } from "../modules/platform-health/presentation/health.controller.js";

export interface AppContainer {
  readonly healthController: HealthController;
}

export function createContainer(): AppContainer {
  const healthService = new HealthService();
  return { healthController: new HealthController(healthService) };
}
