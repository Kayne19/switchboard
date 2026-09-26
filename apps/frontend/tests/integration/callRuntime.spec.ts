import { expect, test } from "@playwright/test";
import { DisplayFixtureServer } from "./display-fixture-server.mjs";
import { statusMessage, transcriptEntry } from "../fixtures/serverMessages";

test.describe("call runtime", () => {
  test("the production root mounts no runtime frame or call chrome", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".runtime-controls")).toHaveCount(0);
    await expect(page.locator(".runtime-frame")).toHaveCount(0);
    await expect(page.locator(".damocles-presence__button").first()).toBeVisible();
  });

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
      await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);

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

      fixtureServer.broadcast({ type: "view", target: "comms", reason: "" });
      await expect(page.locator('[data-scene="conversation"]')).toBeVisible();

      // A report already in flight under generation 1 may land as retired;
      // what matters is that the page reports under the new generation once
      // it has seen the epoch.
      fixtureServer.setGeneration(2);
      await expect
        .poll(() =>
          fixtureServer.reports.some((report) => report.generation === 2),
        )
        .toBe(true);
      expect(
        fixtureServer.retiredReports.every((report) => report.generation === 1),
      ).toBe(true);
    } finally {
      await fixtureServer.stop();
    }
  });

  // Issue #22: the caller used to see conversation -> idle -> conversation
  // across a transfer, and a first drawing from the new leg was wiped when
  // the transfer settled.
  test("an operator-to-project handoff never mounts the idle scene and keeps the first drawing", async ({
    page,
  }) => {
    const projectStatus = statusMessage({
      route: "switchboard",
      label: "switchboard",
      projects: ["switchboard"],
      thinking: "medium",
      levels: ["low", "medium", "high"],
    });
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: 1 });
    const { wsUrl } = await fixtureServer.start();

    try {
      await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
      await expect
        .poll(() => fixtureServer.reports.length, { timeout: 10_000 })
        .toBeGreaterThan(0);

      fixtureServer.broadcast({ type: "transcript", id: "c1", text: "Put me through to switchboard." });
      fixtureServer.broadcast({
        type: "spoken",
        entry: transcriptEntry({ id: "a1", role: "agent", text: "Putting you through to switchboard." }),
      });
      await expect(page.locator('main.stage[data-scene-kind="conversation"]')).toBeVisible();

      // Every scene the stage mounts from here on, however briefly.
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { scenesSeen: string[] }).scenesSeen = seen;
        const record = () => {
          const kind = document.querySelector("main.stage")?.getAttribute("data-scene-kind") ?? "";
          if (kind && seen[seen.length - 1] !== kind) seen.push(kind);
        };
        record();
        new MutationObserver(record).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-scene-kind"],
        });
      });

      // The incoming leg shows life: it is adopted and the epoch moves.
      fixtureServer.broadcast({ type: "candidate", route: "switchboard", generation: 1 });
      fixtureServer.broadcast({ type: "candidate_cleared", generation: 2 });
      fixtureServer.setGeneration(2);
      fixtureServer.broadcast(projectStatus);

      // Its first act is a drawing; then the PBX settles and the reply lands.
      fixtureServer.broadcast({
        type: "display",
        seq: 5,
        action: {
          op: "show",
          id: "call-path",
          type: "diagram",
          role: "primary",
          data: {
            mode: "graph",
            title: "Call path",
            nodes: [
              { id: "operator", label: "OPERATOR" },
              { id: "agent", label: "AGENT", state: "active" },
            ],
            edges: [{ from: "operator", to: "agent", label: "patch" }],
          },
        },
      });
      fixtureServer.broadcast(projectStatus);
      fixtureServer.broadcast({ type: "reply", text: "That is the call path.", route: "switchboard" });

      await expect(page.locator('main.stage[data-scene-kind="architecture"]')).toBeVisible();
      await expect(page.locator('[data-testid="diagram"]')).toContainText("AGENT");
      await expect
        .poll(() => {
          const latest = fixtureServer.reports[fixtureServer.reports.length - 1];
          return latest?.generation === 2 && latest?.applied_seq === 5 && latest?.title === "Call path";
        })
        .toBe(true);

      const scenesSeen = await page.evaluate(
        () => (window as unknown as { scenesSeen: string[] }).scenesSeen,
      );
      expect(scenesSeen).toEqual(["conversation", "architecture"]);
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
      await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
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
      await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
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
