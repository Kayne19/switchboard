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

test("tool activity never flashes over the explanation", async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 2 });
  const { wsUrl } = await fixtureServer.start();
  const explanation = "The route runs through the operator, then the project leg.";

  try {
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === "hello")).toBe(true);
    fixtureServer.broadcast({
      type: "display",
      action: {
        op: "show",
        id: "route",
        type: "diagram",
        role: "primary",
        data: { mode: "graph", title: "Route", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] },
      },
    });
    fixtureServer.broadcast({ type: "spoken", entry: { role: "agent", text: explanation, id: "reply-1" } });
    const explanationText = page.locator(".live-chat-card__text");
    await expect(explanationText).toHaveText(explanation);

    // Record every state the explanation passes through, down to single
    // mutations, while a burst of tool calls starts and ends.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { explanationStates: string[] }).explanationStates = seen;
      const record = () => seen.push(document.querySelector(".live-chat-card__text")?.textContent ?? "<gone>");
      new MutationObserver(record).observe(document.querySelector(".stage")!, { subtree: true, childList: true, characterData: true });
    });
    const calls = [
      ["read", "apps/backend/src/api.rs"],
      ["bash", "cargo test"],
      ["edit", "apps/frontend/src/App.tsx"],
    ];
    for (const [tool, detail] of calls) {
      fixtureServer.broadcast({ type: "activity", state: "start", tool, detail, label: "switchboard" });
      await page.waitForTimeout(60);
      fixtureServer.broadcast({ type: "activity", state: "end", tool, detail: "", label: "switchboard" });
      await page.waitForTimeout(40);
    }
    const states = await page.evaluate(() => (window as unknown as { explanationStates: string[] }).explanationStates);
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set([explanation]));

    // The calls showed on the activity surface instead, and it settles back.
    // Back to back, they are one burst, counted rather than named (#50).
    const caption = page.locator(".damocles-presence__caption");
    await expect(caption).toContainText("WORKING / 3 tool calls", { ignoreCase: true });
    await expect(caption).toContainText("VOICE / ACTIVE", { ignoreCase: true, timeout: 3_000 });
  } finally {
    await fixtureServer.stop();
  }
});

test("the transcript input types in the transcript's own face at every size", async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 1 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === "hello")).toBe(true);
    fixtureServer.broadcast({ type: "history", entries: [{ role: "caller", text: "Show me the call path.", id: "clip-1" }] });
    await page.locator(".transcript-toggle").click();
    const input = page.getByRole("textbox", { name: "Conversation input" });
    await input.fill("Typed text keeps its proportions");

    for (const [width, height] of [[1440, 900], [2560, 1080], [820, 1180], [600, 1000], [390, 844], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const where = `${width}x${height}`;
      const sample = await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>(".transcript__input")!;
        const line = document.querySelector(".transcript-line:not(.transcript-line--ai) .transcript-line__text")!;
        const send = document.querySelector(".transcript__send")!;
        const type = (element: Element) => {
          const style = getComputedStyle(element);
          return { family: style.fontFamily, size: style.fontSize, stretch: style.fontStretch, spacing: style.letterSpacing, weight: style.fontWeight };
        };
        // The rendered advance of the typed text in each element's font.
        const advance = (element: Element, text: string) => {
          const style = getComputedStyle(element);
          const context = document.createElement("canvas").getContext("2d")!;
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          return context.measureText(text).width;
        };
        const transformed: string[] = [];
        for (let element: Element | null = field; element; element = element.parentElement) {
          if (getComputedStyle(element).transform !== "none") transformed.push(element.className.toString());
        }
        const fieldBox = field.getBoundingClientRect();
        const sendBox = send.getBoundingClientRect();
        return {
          field: type(field),
          line: type(line),
          advanceRatio: advance(field, field.value) / advance(line, field.value),
          transformed,
          aligned: Math.abs(fieldBox.top - sendBox.top) < 1 && Math.abs(fieldBox.bottom - sendBox.bottom) < 1,
        };
      });
      expect(sample.field, where).toEqual(sample.line);
      expect(sample.advanceRatio, where).toBeCloseTo(1, 3);
      expect(sample.transformed, where).toEqual([]);
      expect(sample.aligned, where).toBe(true);
    }
  } finally {
    await fixtureServer.stop();
  }
});

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

    const explanation = page.locator(".live-chat-card__text");
    await expect(explanation.locator("strong")).toHaveText("route");
    await expect(explanation.locator("code")).toHaveText("route_final_transcript");
    await expect(explanation.locator("li")).toHaveCount(2);
    await expect(explanation).not.toContainText("**");
    const overflow = await explanation.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollable: element.scrollHeight > element.clientHeight,
    }));
    expect(overflow).toEqual({ overflowY: "auto", scrollable: true });

    await page.locator(".live-chat-card__history").click();
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
