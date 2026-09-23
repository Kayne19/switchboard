import { expect, test } from "@playwright/test";
import { DisplayFixtureServer } from "../integration/display-fixture-server.mjs";

test("production adapter maps backend traffic into semantic scenes", async ({
  page,
}) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 1 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    // The approved design exposes no call chrome; scenes are driven purely by
    // backend traffic on the page's own socket.
    await expect(page.locator(".runtime-controls")).toHaveCount(0);
    await expect
      .poll(() => fixtureServer.frames.some((frame) => frame.type === "hello"))
      .toBe(true);

    fixtureServer.broadcast({
      type: "status",
      route: "switchboard",
      label: "switchboard",
      projects: ["switchboard"],
      model_name: "openai/gpt-5",
      models: [{ provider: "openai", model: "gpt-5", thinks: true }],
      thinking: "high",
      thinking_confirmed: true,
      levels: ["high"],
    });

    fixtureServer.broadcast({
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

    fixtureServer.broadcast({
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

    fixtureServer.broadcast({
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

    fixtureServer.broadcast({ type: "view", target: "comms" });
    await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
    await expect(page.locator(".transcript-toggle")).toBeVisible();
  } finally {
    await fixtureServer.stop();
  }
});
