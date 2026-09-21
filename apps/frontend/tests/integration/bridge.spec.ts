import { expect, test } from "@playwright/test";
import { DisplayFixtureServer } from "./display-fixture-server.mjs";

test("production root loads the isolated runtime and relays voice controls", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".runtime-controls")).toHaveCount(0);
  await expect(page.locator(".runtime-frame")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  const runtime = page.frameLocator(".runtime-frame");
  await expect(runtime.locator("#talkBtn")).toBeAttached();
  await expect(runtime.locator("#handsFreeBtn")).toBeAttached();
  await expect(runtime.locator("#routeSelect")).toBeAttached();
  await expect(runtime.locator("html")).toHaveAttribute(
    "data-switchboard-bridge",
    "ready",
  );

  await runtime.locator("body").evaluate((body) => {
    body.dataset.parentRetryClicks = "0";
    document.getElementById("retryBtn")?.addEventListener("click", () => {
      body.dataset.parentRetryClicks = String(
        Number(body.dataset.parentRetryClicks ?? "0") + 1,
      );
    });
  });

  await page.locator(".damocles-presence__button").first().click();
  await expect(runtime.locator("body")).toHaveAttribute(
    "data-parent-retry-clicks",
    "1",
  );
});

test("runtime bridge handles display events, replay, screen_state bridge queue/ack, and runtime separation", async ({
  page,
}) => {
  const replayMetric = {
    op: "show",
    id: "system-load",
    type: "metric",
    role: "ambient",
    data: { label: "LOAD", value: "0.42" },
  };

  const fixtureServer = new DisplayFixtureServer({
    initialGeneration: 1,
    replayActions: [replayMetric],
  });

  const { wsUrl } = await fixtureServer.start();

  try {
    // 1. Navigate with custom WS pointing to our fixture server
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);

    const runtime = page.frameLocator(".runtime-frame");
    await expect(runtime.locator("html")).toHaveAttribute(
      "data-switchboard-bridge",
      "ready",
    );

    // 2. Verify replay was delivered and V17 received it
    // Wait for the server to receive the initial screen_state report acknowledging replay
    await expect.poll(() => fixtureServer.reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const initialReport = fixtureServer.reports[fixtureServer.reports.length - 1];
    expect(initialReport.generation).toBe(1);
    expect(initialReport.has_visual).toBe(true);
    expect(initialReport.object_ids).toContain("system-load");
    expect(fixtureServer.acksSent).toBeGreaterThan(0);

    // 3. Send a live display action (structured graph diagram)
    const liveDiagram = {
      op: "show",
      id: "live-flow",
      type: "diagram",
      role: "primary",
      data: {
        mode: "graph",
        title: "Live Flow",
        nodes: [
          { id: "src", label: "SOURCE" },
          { id: "dst", label: "DEST", state: "active" },
        ],
        edges: [{ from: "src", to: "dst", label: "flow" }],
      },
    };

    fixtureServer.broadcast({
      type: "display",
      action: liveDiagram,
    });

    // Verify V17 renders the primary diagram in architecture scene
    await expect(page.locator('[data-scene="architecture"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="diagram"] svg')).toBeVisible();
    await expect(page.locator('[data-testid="diagram"]')).toContainText("DEST");

    // Verify updated screen_state was sent across bridge with visual_kind 'diagram'
    await expect.poll(
      () => {
        const latest = fixtureServer.reports[fixtureServer.reports.length - 1];
        return latest?.visual_kind === "diagram" && latest?.title === "Live Flow";
      },
      { timeout: 10_000 },
    ).toBe(true);

    // 4. Test view command
    fixtureServer.broadcast({
      type: "view",
      target: "comms",
    });
    await expect(page.locator('[data-scene="conversation"]')).toBeVisible();

    // 5. Test agent clear separates from runtime
    // Agent clear removes agent objects, but conversation / runtime remains intact
    fixtureServer.broadcast({
      type: "display",
      action: { op: "clear" },
    });
    await expect(page.locator('[data-scene="conversation"]')).toBeVisible();

    // 6. Test retired generation: server rotates generation to 2
    fixtureServer.setGeneration(2);

    // If a report from old generation 1 arrives, server records it as retired
    // Synthesize an old report from the browser context to verify rejection
    await page.evaluate(({ wsUrl }) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: "screen_state",
          view: "auto",
          generation: 1, // retired generation
          has_visual: false,
          object_ids: [],
          title: "",
          stale: false,
        }));
      };
    }, { wsUrl });

    await expect.poll(() => fixtureServer.retiredReports.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(fixtureServer.retiredReports[0].generation).toBe(1);
  } finally {
    await fixtureServer.stop();
  }
});
