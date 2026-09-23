import { expect, test } from "@playwright/test";
import { DisplayFixtureServer } from "../integration/display-fixture-server.mjs";

const longReply = [
  "The **route** is on screen. I checked `route_final_transcript` and it gates both paths:",
  "",
  "- steering the live agent",
  "- queuing a new turn",
  "",
  ...Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1} of the explanation keeps going so it cannot fit.`),
].join("\n");

test("explanations read Markdown, scroll, and open a history the caller can type into", async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 4 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === "hello")).toBe(true);

    fixtureServer.broadcast({
      type: "history",
      entries: [{ role: "caller", text: "Show me the call path.", id: "clip-1" }],
    });
    fixtureServer.broadcast({
      type: "display",
      action: {
        op: "show",
        id: "route",
        type: "diagram",
        role: "primary",
        data: {
          mode: "graph",
          title: "Route",
          nodes: [
            { id: "browser", label: "Browser" },
            { id: "agent", label: "Agent" },
          ],
          edges: [{ from: "browser", to: "agent" }],
        },
      },
    });
    fixtureServer.broadcast({ type: "spoken", entry: { role: "agent", text: longReply, id: "reply-1" } });
    await expect(page.locator('[data-scene="architecture"]')).toBeVisible();

    const explanation = page.locator(".rail-note .annotation-card__text");
    await expect(explanation.locator("strong")).toHaveText("route");
    await expect(explanation.locator("code")).toHaveText("route_final_transcript");
    await expect(explanation.locator("li")).toHaveCount(2);
    await expect(explanation).not.toContainText("**");
    const overflow = await explanation.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollable: element.scrollHeight > element.clientHeight,
    }));
    expect(overflow).toEqual({ overflowY: "auto", scrollable: true });

    await page.locator(".rail-note .annotation-card__history").click();
    const drawer = page.getByRole("dialog", { name: "Conversation history" });
    await expect(drawer).toBeVisible();
    // The history opens over the scene rather than replacing it.
    await expect(page.locator('[data-scene="architecture"]')).toHaveCount(1);
    await expect(drawer).toContainText("Show me the call path.");

    const input = drawer.getByRole("textbox", { name: "Conversation input" });
    await input.fill("run the tests");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect
      .poll(() => fixtureServer.frames.find((frame) => frame.type === "typed_turn"))
      .toMatchObject({ type: "typed_turn", generation: 4, text: "run the tests" });
    const sent = fixtureServer.frames.find((frame) => frame.type === "typed_turn");

    fixtureServer.broadcast({ type: "transcript", id: sent.id, text: "run the tests" });
    await expect(drawer.locator(".transcript-line").last()).toContainText("run the tests");

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  } finally {
    await fixtureServer.stop();
  }
});
