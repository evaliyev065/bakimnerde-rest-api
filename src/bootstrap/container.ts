import type { AppConfig } from "../config/env.js";
import { MongoDatabase } from "../infrastructure/mongodb/database.js";
import { CommerceService } from "../modules/commerce/application/commerce.service.js";
import { CommerceController } from "../modules/commerce/presentation/commerce.controller.js";
import { AuditService } from "../modules/identity/application/audit.service.js";
import { AuthService } from "../modules/identity/application/auth.service.js";
import { ContractorRegistrationService } from "../modules/identity/application/contractor-registration.service.js";
import { TenantService } from "../modules/identity/application/tenant.service.js";
import { UserManagementService } from "../modules/identity/application/user-management.service.js";
import { ContractorRegistrationController } from "../modules/identity/presentation/contractor-registration.controller.js";
import { IdentityController } from "../modules/identity/presentation/identity.controller.js";
import { UserManagementController } from "../modules/identity/presentation/user-management.controller.js";
import { JobQueryService } from "../modules/operations/application/job-query.service.js";
import { JobCollaborationService } from "../modules/operations/application/job-collaboration.service.js";
import { JobCollaborationController } from "../modules/operations/presentation/job-collaboration.controller.js";
import { JobController } from "../modules/operations/presentation/job.controller.js";
import { HealthService } from "../modules/platform-health/application/health.service.js";
import { HealthController } from "../modules/platform-health/presentation/health.controller.js";

export interface AppContainer {
  readonly healthController: HealthController;
  readonly identityController: IdentityController;
  readonly contractorRegistrationController: ContractorRegistrationController;
  readonly userManagementController: UserManagementController;
  readonly commerceController: CommerceController;
  readonly jobController: JobController;
  readonly jobCollaborationController: JobCollaborationController;
  readonly database: MongoDatabase;
}

export function createContainer(config: AppConfig): AppContainer {
  const database = new MongoDatabase(config);
  const healthService = new HealthService();
  const auditService = new AuditService(database);
  const authService = new AuthService(database, config.authTokenSecret);
  const tenantService = new TenantService(database);
  return {
    database,
    healthController: new HealthController(healthService),
    identityController: new IdentityController(authService, tenantService, auditService),
    contractorRegistrationController: new ContractorRegistrationController(
      new ContractorRegistrationService(database),
      auditService,
    ),
    userManagementController: new UserManagementController(new UserManagementService(database), auditService),
    commerceController: new CommerceController(new CommerceService(database), auditService),
    jobController: new JobController(new JobQueryService(database), auditService),
    jobCollaborationController: new JobCollaborationController(new JobCollaborationService(database), auditService),
  };
}
