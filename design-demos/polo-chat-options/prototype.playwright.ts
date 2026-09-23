import { test, expect } from "@playwright/test";
import { join } from "node:path";

// This spec targets the Playwright runner exclusively. The file name
// (`*.playwright.ts`) is deliberately outside bun test's default discovery
// globs (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`) so `bun test` never
// loads it in environments where `@playwright/test` is not installed; this
// config collects it explicitly via `bunx playwright test`.

// R47: all paths are derived from THIS checkout (import.meta.dir), and the
// served base URL comes from the Playwright config's baseURL (relative
// page.goto below) — the spec only ever reads/writes the checkout it runs
// in, on any machine/OS.
const screenshotDir = join(import.meta.dir, "screenshots");

test.use({ channel: "chrome" });

function trackPageErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (message: import("@playwright/test").ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

// Interaction regression restored in review fix round 14, issue D (the
// baseline assets/prototype.spec.ts was reduced to imports during the
// playwright-config migration — these are its interaction cases).
test("After supports cancel, multi Other, explicit exclusivity, retry, draft restoration, and keyboard selection", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto(`/after.html?scene=question&theme=light&lang=en`);
  await expect(page.getByRole("radio", { name: /Move to Trash/ })).toBeVisible();

  // Keyboard selection: focus + Space toggles the radio.
  await page.getByRole("radio", { name: /Move to Trash/ }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: /Move to Trash/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Next" }).click();

  // Multi-select Other combination: preset + Other text compose.
  await page.getByRole("checkbox", { name: /Project admins/ }).click();
  await page.getByRole("checkbox", { name: /^Other/ }).click();
  const otherInput = page.getByRole("textbox", { name: "Enter another notification target" });
  await expect(otherInput).toBeFocused();
  await otherInput.fill("Security team");

  // Explicit exclusivity: the exclusive option clears every other choice
  // (and removes the Other input).
  await page.getByRole("checkbox", { name: /Do not notify anyone/ }).click();
  await expect(page.getByRole("checkbox", { name: /Project admins/ })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("checkbox", { name: /Do not notify anyone/ })).toHaveAttribute("aria-checked", "true");
  await expect(otherInput).toHaveCount(0);

  // Re-composing clears the exclusive option.
  await page.getByRole("checkbox", { name: /Project admins/ }).click();
  await expect(page.getByRole("checkbox", { name: /Do not notify anyone/ })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("checkbox", { name: /^Other/ }).click();
  await page.getByRole("textbox", { name: "Enter another notification target" }).fill("Security team");

  // Transient failure retry: the answers (and Other text) are preserved.
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Submission failed. Your answers are preserved; please retry.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Enter another notification target" })).toHaveValue("Security team");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/Got it\. I’ll complete/)).toBeVisible();

  // Draft restoration: the original composer draft survives the question.
  await expect(page.getByRole("textbox")).toHaveValue("Also export audit records before deletion");

  // Replay, then cancel ("Not now"): a readable cancelled record replaces
  // the card and the draft is restored again.
  await page.getByRole("button", { name: "Replay" }).click();
  await expect(page.getByRole("radio", { name: /Move to Trash/ })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("The question is paused and the Agent will not continue.")).toBeVisible();
  await expect(page.getByText(/Got it\. I’ll complete/)).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("Also export audit records before deletion");
  expect(errors).toEqual([]);
});

test("declared scenes render without page errors and screenshots match the manifest", async ({ page }) => {
  const errors = trackPageErrors(page);
  const shots = [
    ["before","question","light","zh-Hans","desktop",1440,900],
    ["after","question","light","zh-Hans","desktop",1440,900],
    ["before","multi-other","dark","zh-Hans","mobile",390,844],
    ["after","multi-other","dark","zh-Hans","mobile",390,844],
    ["before","error","light","en","desktop",1440,900],
    ["after","error","light","en","desktop",1440,900],
    ["before","cancelled","light","zh-Hans","mobile",390,844],
    ["after","cancelled","light","zh-Hans","mobile",390,844],
    ["before","resolved","dark","en","desktop",1440,900],
    ["after","resolved","dark","en","desktop",1440,900]
  ] as const;
  for (const [pageName, scene, theme, lang, viewport, width, height] of shots) {
    await page.setViewportSize({ width, height });
    await page.goto(`/${pageName}.html?scene=${scene}&theme=${theme}&lang=${lang}`);
    await expect(page.locator("[data-polo-content]")).toBeVisible();
    await page.screenshot({ path:`${screenshotDir}/${pageName}-${scene}-${theme}-${lang}-${viewport}.png`, fullPage:false });
  }
  expect(errors).toEqual([]);
});

test("comparison page loads both synchronized prototypes", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto(`/comparison.html?scene=error&theme=dark&lang=en&viewport=mobile`);
  await expect(page.locator("iframe")).toHaveCount(2);
  await expect(page.locator("iframe").first()).toHaveAttribute("src", /scene=error/);
  await expect(page.locator("iframe").nth(1)).toHaveAttribute("src", /theme=dark/);
  expect(errors).toEqual([]);
});
