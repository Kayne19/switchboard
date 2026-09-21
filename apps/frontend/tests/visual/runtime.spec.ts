import { expect, test } from "@playwright/test";

async function publish(
  page: import("@playwright/test").Page,
  kind: string,
  payload: unknown,
) {
  await page.evaluate(
    ({ kind, payload }) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { source: "switchboard-legacy-runtime", kind, payload },
        }),
      );
    },
    { kind, payload },
  );
}

test("production adapter maps backend traffic into semantic scenes", async ({
  page,
}) => {
  await page.goto("/");
  // The approved design exposes no call chrome; scenes are driven purely by
  // backend traffic through the hidden voice frame.
  await expect(page.locator(".runtime-controls")).toHaveCount(0);

  await publish(page, "state", {
    connected: true,
    recording: false,
    status: "Connected. Tap Talk and speak.",
    handsFree: false,
    handsFreeStatus: "Standby",
    handsFreeLease: "",
    route: "switchboard",
    routes: [
      { value: "operator", label: "Operator" },
      { value: "switchboard", label: "switchboard" },
    ],
    model: "openai/gpt-5",
    models: [{ value: "openai/gpt-5", label: "openai/gpt-5" }],
    thinking: "high",
    thinkingLevels: [{ value: "high", label: "thinking: high" }],
    onProject: true,
    modelDisabled: false,
    thinkingDisabled: false,
  });

  await publish(page, "server", {
    type: "history",
    entries: [
      { role: "caller", text: "Show me the call path.", id: "clip-1" },
      { role: "agent", text: "I have the route on screen." },
    ],
  });
  await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
  await expect(page.locator(".conversation-answer")).toContainText(
    "I have the route on screen.",
  );

  await publish(page, "server", {
    type: "display",
    action: {
      op: "show",
      id: "live-route",
      type: "diagram",
      role: "primary",
      data: {
        mode: "graph",
        title: "Live route",
        nodes: [
          { id: "browser", label: "Browser" },
          { id: "agent", label: "Project agent", state: "active" },
        ],
        edges: [{ from: "browser", to: "agent", label: "route" }],
      },
    },
  });
  await expect(page.locator('[data-scene="architecture"]')).toBeVisible();
  await expect(page.locator('[data-testid="diagram"] svg')).toBeVisible();
  await expect(page.locator('[data-testid="diagram"]')).toContainText(
    "Project agent",
  );

  await publish(page, "server", {
    type: "display",
    action: {
      op: "show",
      id: "live-route",
      type: "code",
      role: "primary",
      data: {
        title: "Live changes",
        file: "patch.diff",
        source: {
          text: "@@ -1 +1 @@\n-old shell\n+new shell",
        },
      },
    },
  });
  await expect(page.locator('[data-scene="code"]')).toBeVisible();
  await expect(page.locator('[data-testid="code"]')).toContainText(
    "+new shell",
  );

  await publish(page, "server", { type: "view", target: "comms" });
  await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
  await expect(page.locator(".transcript-toggle")).toBeVisible();
});
