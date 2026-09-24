import { expect, test } from "@playwright/test";
import { DisplayFixtureServer } from "./display-fixture-server.mjs";

// The voice-free path on the production build: from the idle stage, before
// anything has been said, the caller finds the hidden transcript toggle at the
// bottom of the stage, types a turn, and sees it taken.
test("a caller reaches the line from idle by typing, without speaking", async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 2 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    // The first screen-state report means the epoch has landed, so the line
    // can take a typed turn.
    await expect
      .poll(() => fixtureServer.reports.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const stage = page.locator("main.stage");
    await expect(stage).toHaveAttribute("data-scene-kind", "idle");

    const toggle = page.locator(".scene--idle .transcript-reveal .transcript-toggle");
    await expect(toggle).toHaveCSS("opacity", "0");
    await page.mouse.move(360, 880);
    await expect(toggle).toHaveCSS("opacity", "1");
    await toggle.click();

    const drawer = page.getByRole("dialog", { name: "Conversation history" });
    const input = drawer.getByRole("textbox", { name: "Conversation input" });
    await expect(input).toBeFocused();
    await page.keyboard.type("What is on the line?");
    await page.keyboard.press("Enter");

    await expect
      .poll(() => fixtureServer.frames.find((frame) => frame.type === "typed_turn"))
      .toMatchObject({ type: "typed_turn", generation: 2, text: "What is on the line?" });
    await expect(input).toHaveValue("");

    // Taken and echoed as the caller's line: the conversation comes up under
    // the drawer, which stays open with the field still ready.
    await expect(drawer.locator(".transcript-line")).toHaveText([/CALLER\s*What is on the line\?/]);
    await expect(stage).toHaveAttribute("data-scene-kind", "conversation");
    await expect(drawer).toBeVisible();
    await expect(input).toBeFocused();
    expect(
      fixtureServer.frames.some(
        (frame) => frame.type === "clip" || String(frame.type).startsWith("stt_") || frame.binary !== undefined,
      ),
    ).toBe(false);

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.locator(".scene--conversation .conversation-answer")).toBeVisible();
  } finally {
    await fixtureServer.stop();
  }
});
