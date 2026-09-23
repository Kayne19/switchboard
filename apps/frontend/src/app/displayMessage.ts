import { validateControllerAction } from "../controller/validation";

export function interpretDisplayMessage(message: { action?: unknown; seq?: unknown }): {
  result: ReturnType<typeof validateControllerAction>;
  seq: number | undefined;
} {
  const seq = typeof message.seq === "number" ? message.seq : undefined;
  const result = validateControllerAction(message.action);
  return { result, seq };
}
