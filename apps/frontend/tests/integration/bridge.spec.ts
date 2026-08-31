import { expect, test } from "@playwright/test";

test("production root loads the isolated runtime and relays voice controls", async ({
  page,
}) => {
  await page.goto("/");
  // The approved design has no visible call chrome: only the hidden voice frame
  // and the on-screen Damocles presence.
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

  // Fresh load is disconnected, so the presence toggle relays a link retry.
  await page.locator(".damocles-presence__button").first().click();
  await expect(runtime.locator("body")).toHaveAttribute(
    "data-parent-retry-clicks",
    "1",
  );
});
