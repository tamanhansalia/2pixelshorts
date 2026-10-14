import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const brand = path.join(root, "public/brand");
const nativeIcons = path.join(root, "src-tauri/icons");
const source = readFileSync(path.join(brand, "logo-source.png"));
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
const temporary = mkdtempSync(path.join(tmpdir(), "2pixelshorts-brand-"));

function generate(input, output, extra = []) {
  const result = spawnSync(process.execPath, [cli, "icon", input, "--output", output, ...extra], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (${result.status})`);
}

function embeddedSvg(png, size, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><title>${title}</title><image width="${size}" height="${size}" href="data:image/png;base64,${png.toString("base64")}"/></svg>\n`;
}

try {
  // Preserve the supplied artwork. Clip only the black outer square corners
  // to follow its rounded tile; the ribbon, gradients, and glow stay intact.
  const master = path.join(temporary, "logo.svg");
  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  if (width !== height) throw new Error("The source logo must be a square PNG.");
  writeFileSync(master, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${width} ${width}"><defs><clipPath id="tile"><rect width="${width}" height="${width}" rx="${width * 0.23}"/></clipPath></defs><image width="${width}" height="${width}" clip-path="url(#tile)" href="data:image/png;base64,${source.toString("base64")}"/></svg>`);

  generate(master, nativeIcons, ["--ios-color", "#000000"]);
  const sizes = [16, 32, 48, 64, 128, 180, 256, 512, 1024];
  generate(master, temporary, sizes.flatMap((size) => ["--png", String(size)]));
  for (const size of sizes) {
    copyFileSync(path.join(temporary, `${size}x${size}.png`), path.join(brand, `logo-${size}.png`));
  }
  copyFileSync(path.join(brand, "logo-64.png"), path.join(nativeIcons, "64x64.png"));
  copyFileSync(path.join(nativeIcons, "icon.ico"), path.join(root, "public/favicon.ico"));
  copyFileSync(path.join(brand, "logo-32.png"), path.join(root, "public/favicon-32.png"));
  // Touch icons require an opaque canvas; Tauri already produces that for iOS.
  copyFileSync(path.join(nativeIcons, "ios/AppIcon-60x60@3x.png"), path.join(root, "public/apple-touch-icon.png"));

  writeFileSync(path.join(root, "public/favicon.svg"), embeddedSvg(readFileSync(path.join(brand, "logo-128.png")), 128, "2PixelShorts"));
  // Keep existing public URLs valid with the same artwork on both themes.
  const mark = embeddedSvg(readFileSync(path.join(brand, "logo-256.png")), 256, "2PixelShorts logo");
  for (const name of ["logo-mark.svg", "logo-mark-light.svg"]) {
    writeFileSync(path.join(brand, name), mark);
  }
  console.log("Updated web, macOS, Windows, Android, and iOS logos from public/brand/logo-source.png.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
