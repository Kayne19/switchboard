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
    // Reproduce a cold-mount race by delaying the parent's message listener.
    // The iframe must keep announcing itself and must not open its WebSocket
    // (or receive the replay snapshot) until that listener answers.
    await page.addInitScript(() => {
      if (window.parent !== window) return;
      const addEventListener = window.addEventListener.bind(window);
      window.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === "message") {
          window.setTimeout(
            () => addEventListener(type, listener, options),
            400,
          );
          return;
        }
        addEventListener(type, listener, options);
      }) as typeof window.addEventListener;
    });

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

test.describe("native runtime", () => {
  test("owns the backend socket: replay, display, screen_state queue/ack, view, retired generation", async ({
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
      await page.goto(`/?native&ws=${encodeURIComponent(wsUrl)}`);

      // No hidden frame: the page itself opened the socket and said hello.
      await expect(page.locator(".runtime-frame")).toHaveCount(0);
      await expect
        .poll(() => fixtureServer.frames.some((frame) => frame.type === "hello"))
        .toBe(true);

      await expect
        .poll(() => fixtureServer.reports.length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      const initialReport =
        fixtureServer.reports[fixtureServer.reports.length - 1];
      expect(initialReport.generation).toBe(1);
      expect(initialReport.has_visual).toBe(true);
      expect(initialReport.object_ids).toContain("system-load");

      fixtureServer.broadcast({
        type: "display",
        seq: 7,
        action: {
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
        },
      });
      await expect(page.locator('[data-scene="architecture"]')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('[data-testid="diagram"]')).toContainText(
        "DEST",
      );
      await expect
        .poll(() => {
          const latest = fixtureServer.reports[fixtureServer.reports.length - 1];
          return (
            latest?.visual_kind === "diagram" &&
            latest?.title === "Live Flow" &&
            latest?.applied_seq === 7
          );
        })
        .toBe(true);

      // A rejected action is reported back rather than dropped.
      fixtureServer.broadcast({
        type: "display",
        seq: 8,
        action: { op: "show", id: "bad", type: "diagram", data: { mode: "tree" } },
      });
      await expect
        .poll(() =>
          fixtureServer.reports.some((report) => report.rejected?.seq === 8),
        )
        .toBe(true);

      fixtureServer.broadcast({ type: "view", target: "comms" });
      await expect(page.locator('[data-scene="conversation"]')).toBeVisible();

      fixtureServer.setGeneration(2);
      await expect
        .poll(() =>
          fixtureServer.reports.some((report) => report.generation === 2),
        )
        .toBe(true);
      expect(fixtureServer.retiredReports).toEqual([]);
    } finally {
      await fixtureServer.stop();
    }
  });

  test("the presence records a push-to-talk clip and sends it on the socket", async ({
    page,
  }) => {
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: 3 });
    const { wsUrl } = await fixtureServer.start();
    try {
      await page.goto(`/?native&ws=${encodeURIComponent(wsUrl)}`);
      await expect
        .poll(() => fixtureServer.frames.some((frame) => frame.type === "hello"))
        .toBe(true);

      const presence = page.locator(".damocles-presence__button").first();
      await presence.click();
      await expect(presence).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(600);
      await presence.click();

      // The fixture offers streaming STT, so the clip goes out as it is
      // recorded: stt_start, chunk headers each followed by audio, stt_end.
      await expect
        .poll(() => fixtureServer.frames.find((frame) => frame.type === "stt_end"))
        .toMatchObject({ type: "stt_end", generation: 3 });
      const clipFrames = fixtureServer.frames.filter(
        (frame) => frame.binary !== undefined || frame.type?.startsWith("stt_"),
      );
      const clipId = clipFrames.find((frame) => frame.type === "stt_start")?.clip_id;
      expect(clipId).toBeTruthy();
      expect(
        clipFrames.filter((frame) => frame.type === "stt_chunk").length,
      ).toBeGreaterThan(0);
      expect(
        clipFrames.filter((frame) => frame.binary > 0).length,
      ).toBeGreaterThan(0);
      expect(
        clipFrames
          .filter((frame) => frame.type)
          .every((frame) => frame.clip_id === clipId && frame.generation === 3),
      ).toBe(true);
    } finally {
      await fixtureServer.stop();
    }
  });

  test("reconnects after the backend drops the socket", async ({ page }) => {
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: 1 });
    const { wsUrl } = await fixtureServer.start();
    try {
      await page.goto(`/?native&ws=${encodeURIComponent(wsUrl)}`);
      await expect
        .poll(() => fixtureServer.frames.filter((f) => f.type === "hello").length)
        .toBe(1);
      for (const client of fixtureServer.clients) client.terminate();
      await expect
        .poll(
          () => fixtureServer.frames.filter((f) => f.type === "hello").length,
          { timeout: 10_000 },
        )
        .toBe(2);
    } finally {
      await fixtureServer.stop();
    }
  });
});
