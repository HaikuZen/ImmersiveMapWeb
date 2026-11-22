// Opens the playground in the system Chrome, waits for tiles, saves a
// screenshot and prints the map's stats, then runs the benchmark page.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:4173";
const out = process.argv[3] ?? ".";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: process.env.HEADED ? false : true,
  args: ["--enable-gpu", "--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return a ? { vendor: a.info.vendor, architecture: a.info.architecture, features: [...a.features] } : null;
});
console.log("adapter:", JSON.stringify(adapter));

await page.goto(`${base}/?lon=37.6175&lat=55.752&zoom=14`);
await page.waitForFunction(() => window.tileStats?.length >= 6, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/map-moscow-z14.png` });
console.log("hud:\n" + (await page.textContent("#hud")));

// Pan and zoom a little to drive frames, then read the HUD again.
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -12); await page.waitForTimeout(16); }
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/map-moscow-zoomed.png` });
console.log("hud after zoom:\n" + (await page.textContent("#hud")));

await page.goto(`${base}/bench.html`);
await page.waitForFunction(() => window.benchResults || window.benchError, null, { timeout: 120000 });
console.log("bench:", JSON.stringify(await page.evaluate(() => window.benchResults ?? window.benchError)));
await browser.close();
