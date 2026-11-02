import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const page = await browser.contexts()[0].newPage();
await page.goto(process.env.BOX_UI ?? "http://127.0.0.1:6080/");
const info = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) return null;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    vendor: String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    webgpu: "gpu" in navigator,
  };
});
await page.close();
await browser.close();

console.log("webgl vendor:", info?.vendor ?? "unavailable");
console.log("webgl renderer:", info?.renderer ?? "unavailable");
console.log("webgpu:", info?.webgpu ? "available" : "unavailable");
console.log(!info
  ? "gpu rendering: WebGL unavailable"
  : /swiftshader|llvmpipe|soft/i.test(info.renderer)
    ? "gpu rendering: software (CPU)"
    : "gpu rendering: hardware (GPU)");
