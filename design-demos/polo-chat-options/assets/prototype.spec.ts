import { test, expect } from "@playwright/test";

const base = "http://127.0.0.1:8765/design-demos/polo-chat-options";
const screenshotDir = "/Users/wow/project/z-h-ai/polo-dir/POO-50/feature/polo-chat-options/design-demos/polo-chat-options/screenshots";

test.use({ channel: "chrome" });

function trackPageErrors(page: any) {
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (message: any) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("After supports cancel, multi Other, explicit exclusivity, retry, draft restoration, and keyboard selection", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto(`${base}/after.html?scene=question&theme=light&lang=en`);
  await expect(page.getByRole("radio", { name: /Move to Trash/ })).toBeVisible();

  await page.getByRole("radio", { name: /Move to Trash/ }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: /Move to Trash/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Next" }).click();

  await page.getByRole("checkbox", { name: /Project admins/ }).click();
  await page.getByRole("checkbox", { name: /^Other/ }).click();
  const otherInput = page.getByRole("textbox", { name: "Enter another notification target" });
  await expect(otherInput).toBeFocused();
  await otherInput.fill("Security team");

  await page.getByRole("checkbox", { name: /Do not notify anyone/ }).click();
  await expect(page.getByRole("checkbox", { name: /Project admins/ })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("checkbox", { name: /Do not notify anyone/ })).toHaveAttribute("aria-checked", "true");
  await expect(otherInput).toHaveCount(0);

  await page.getByRole("checkbox", { name: /Project admins/ }).click();
  await expect(page.getByRole("checkbox", { name: /Do not notify anyone/ })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("checkbox", { name: /^Other/ }).click();
  await page.getByRole("textbox", { name: "Enter another notification target" }).fill("Security team");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Submission failed. Your answers are preserved; please retry.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Enter another notification target" })).toHaveValue("Security team");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/Got it\. I’ll complete/)).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue("Also export audit records before deletion");

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
    await page.goto(`${base}/${pageName}.html?scene=${scene}&theme=${theme}&lang=${lang}`);
    await expect(page.locator("[data-polo-content]")).toBeVisible();
    await page.screenshot({ path:`${screenshotDir}/${pageName}-${scene}-${theme}-${lang}-${viewport}.png`, fullPage:false });
  }
  expect(errors).toEqual([]);
});

test("comparison page loads both synchronized prototypes", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto(`${base}/comparison.html?scene=error&theme=dark&lang=en&viewport=mobile`);
  await expect(page.locator("iframe")).toHaveCount(2);
  await expect(page.locator("iframe").first()).toHaveAttribute("src", /scene=error/);
  await expect(page.locator("iframe").nth(1)).toHaveAttribute("src", /theme=dark/);
  expect(errors).toEqual([]);
});
