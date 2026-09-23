import { describe, expect, it } from "vitest";
import {
  lineStateFromStatus,
  OPERATOR_LINE,
  pickerAvailability,
} from "../../src/runtime/lineStatus";

describe("lineStateFromStatus", () => {
  it("lists the catalog models and keeps the live model selected", () => {
    const line = lineStateFromStatus({
      type: "status",
      route: "alpha",
      label: "alpha",
      model_name: "openai/gpt-5.6",
      models: [
        { provider: "openai", model: "gpt-5.6", thinks: true },
        { provider: "moonshot", model: "luna", thinks: true },
        { provider: "openai", model: "sol", thinks: false },
      ],
      levels: ["off", "high"],
      model_swaps: true,
    });
    expect(line.models.map((option) => option.value)).toEqual([
      "openai/gpt-5.6",
      "moonshot/luna",
      "openai/sol",
    ]);
    expect(line.model).toBe("openai/gpt-5.6");
    expect(line.onProject).toBe(true);
    expect(pickerAvailability(line, false).modelDisabled).toBe(false);
  });

  it("keeps a live model that the catalog does not list", () => {
    const line = lineStateFromStatus({
      type: "status",
      route: "alpha",
      model_name: "provider/unlisted",
      models: [{ provider: "openai", model: "sol", thinks: false }],
    });
    expect(line.models.map((option) => option.value)).toEqual([
      "openai/sol",
      "provider/unlisted",
    ]);
    expect(line.model).toBe("provider/unlisted");
  });

  it("disables only the model picker when the catalog is unavailable", () => {
    const line = lineStateFromStatus({
      type: "status",
      route: "alpha",
      model_name: "provider/model",
      models: [],
      models_available: false,
      models_diagnostic: "model listing failed or timed out",
      levels: ["off", "high"],
      model_swaps: true,
    });
    const availability = pickerAvailability(line, false);
    expect(availability.modelDisabled).toBe(true);
    expect(availability.modelTitle).toBe("model listing failed or timed out");
    expect(availability.thinkingDisabled).toBe(false);
  });

  it("names the operator line and the requested thinking level", () => {
    const line = lineStateFromStatus({
      type: "status",
      route: "operator",
      projects: ["alpha", "beta"],
      model_name: "openai/gpt-5.6",
      thinking: "high",
      thinking_confirmed: false,
      levels: ["off", "high"],
    });
    expect(line.onProject).toBe(false);
    expect(line.label).toBe("Operator");
    expect(line.routes.map((option) => option.value)).toEqual([
      "operator",
      "alpha",
      "beta",
    ]);
    expect(line.thinking).toBe("high");
    expect(line.modelSummary).toBe("openai/gpt-5.6 · thinking high (requested)");
    expect(pickerAvailability(line, false).modelDisabled).toBe(true);
  });

  it("locks every picker while a line request is running", () => {
    const availability = pickerAvailability(OPERATOR_LINE, true);
    expect(availability.routeDisabled).toBe(true);
    expect(availability.modelDisabled).toBe(true);
    expect(availability.thinkingDisabled).toBe(true);
  });

  it("locks thinking on a project leg that cannot swap models", () => {
    const line = lineStateFromStatus({
      type: "status",
      route: "alpha",
      model_swaps: false,
      levels: ["off", "high"],
    });
    expect(pickerAvailability(line, false).thinkingDisabled).toBe(true);
  });
});
