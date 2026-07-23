import { describe, expect, it } from "vitest";
import { HealthService } from "../../src/modules/platform-health/application/health.service.js";

describe("HealthService", () => {
  it("framework bağımsız liveness sonucu üretir", () => {
    expect(new HealthService().getLiveness()).toEqual({
      status: "alive",
      service: "bakimnerde-api"
    });
  });
});
