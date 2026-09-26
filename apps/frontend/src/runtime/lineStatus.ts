// What the backend's `status` event says about the line: who is on it, which
// model and thinking level that leg runs, and which of those the caller may
// change. Pure, so the picker rules can be tested without a socket.

import type { StatusMessage } from "../protocol";

export interface SelectOption {
  value: string;
  label: string;
}

export interface LineState {
  route: string;
  /** Display name for whoever is on the line. */
  label: string;
  routes: SelectOption[];
  model: string;
  models: SelectOption[];
  /** "model · thinking level", marked "(requested)" until the leg confirms it. */
  modelSummary: string;
  thinking: string;
  thinkingLevels: SelectOption[];
  onProject: boolean;
  modelSwaps: boolean;
  modelsAvailable: boolean;
  modelsDiagnostic: string;
}

export interface PickerAvailability {
  routeDisabled: boolean;
  modelDisabled: boolean;
  thinkingDisabled: boolean;
  /** Why the model picker is unavailable, when the catalog failed to load. */
  modelTitle: string;
}

export const OPERATOR_LINE: LineState = {
  route: "operator",
  label: "Operator",
  routes: [{ value: "operator", label: "Operator" }],
  model: "",
  models: [],
  modelSummary: "",
  thinking: "",
  thinkingLevels: [],
  onProject: false,
  modelSwaps: true,
  modelsAvailable: true,
  modelsDiagnostic: "",
};

export function lineStateFromStatus(message: StatusMessage): LineState {
  const onProject = Boolean(message.route && message.route !== "operator");

  // Every leg runs at a level somebody chose, so there is always a level to
  // name. A leg that has not reported back yet is marked as asked-for rather
  // than stated as fact — the runtime may still clamp it.
  const name = message.model_name || message.model || "";
  let level = "";
  if (message.thinking) {
    level = "thinking " + message.thinking;
    if (!message.thinking_confirmed) level += " (requested)";
  }

  const routes: SelectOption[] = [
    { value: "operator", label: "Operator" },
    ...(message.projects || []).map((id) => ({ value: id, label: id })),
  ];

  const currentModel = message.model_name || "";
  const models: SelectOption[] = (message.models || [])
    .filter(
      (entry) =>
        typeof entry?.provider === "string" && typeof entry?.model === "string",
    )
    .map((entry) => ({
      value: entry.provider + "/" + entry.model,
      label: entry.provider + "/" + entry.model,
    }));
  if (currentModel && !models.some((entry) => entry.value === currentModel)) {
    models.push({ value: currentModel, label: currentModel });
  }

  const thinkingLevels: SelectOption[] = (message.levels || []).map(
    (levelName) => ({ value: levelName, label: "thinking: " + levelName }),
  );

  return {
    route: selectedValue(routes, message.route || "operator"),
    label: message.label || "Operator",
    routes,
    model: selectedValue(models, currentModel),
    models,
    modelSummary: [name, level].filter(Boolean).join(" · "),
    thinking: selectedValue(
      thinkingLevels,
      message.thinking || message.thinking_default || "",
    ),
    thinkingLevels,
    onProject,
    modelSwaps: message.model_swaps !== false,
    modelsAvailable: message.models_available !== false,
    modelsDiagnostic: message.models_diagnostic || "",
  };
}

// Connecting dials ssh and starts an agent, and changing the level restarts
// the live leg. While any such request runs, every picker is locked so a
// second pick cannot race the first.
export function pickerAvailability(
  line: LineState,
  busy: boolean,
): PickerAvailability {
  return {
    routeDisabled: busy,
    modelDisabled:
      busy || !line.onProject || !line.modelSwaps || !line.modelsAvailable,
    thinkingDisabled: busy || (line.onProject && !line.modelSwaps),
    modelTitle: line.modelsAvailable
      ? ""
      : line.modelsDiagnostic || "Model catalog unavailable",
  };
}

// The server's choice when it named one; otherwise the first option, which is
// what a select with no explicit value shows.
function selectedValue(options: SelectOption[], current: string): string {
  return current || options[0]?.value || "";
}
