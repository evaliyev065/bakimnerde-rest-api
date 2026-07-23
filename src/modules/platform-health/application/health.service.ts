export interface HealthStatus {
  readonly status: "alive";
  readonly service: "bakimnerde-api";
}

export interface ReadinessStatus {
  readonly status: "ready";
  readonly service: "bakimnerde-api";
  readonly checks: { readonly configuration: "ready" };
}

export class HealthService {
  public getLiveness(): HealthStatus {
    return { status: "alive", service: "bakimnerde-api" };
  }

  public getReadiness(): ReadinessStatus {
    return {
      status: "ready",
      service: "bakimnerde-api",
      checks: { configuration: "ready" }
    };
  }
}
