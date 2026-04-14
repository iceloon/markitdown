import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

if (process.platform !== "darwin") {
  console.error("bundle:dmg 仅支持在 macOS 上执行。");
  process.exit(1);
}

const packageJsonPath = path.join(projectRoot, "package.json");
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

const version = packageJson.version;
const productName = tauriConfig.productName;
const bundleRoot = path.join(projectRoot, "src-tauri", "target", "release", "bundle");
const appPath = path.join(bundleRoot, "macos", `${productName}.app`);
const dmgDir = path.join(bundleRoot, "dmg");
const archLabel = process.arch === "arm64" ? "aarch64" : process.arch;
const dmgPath = path.join(dmgDir, `${productName}_${version}_${archLabel}.dmg`);
const stageDir = mkdtempSync(path.join(os.tmpdir(), "markitdown-converter-dmg-"));
const stageBundleDir = path.join(stageDir, "bundle");

function run(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
  console.log(`Building ${productName}.app via Tauri app bundle...`);
  run("npm", ["run", "bundle:app"]);

  if (!existsSync(appPath)) {
    console.error(`未找到 .app 产物：${appPath}`);
    process.exit(1);
  }

  rmSync(dmgPath, { force: true });
  mkdirSync(dmgDir, { recursive: true });
  mkdirSync(stageBundleDir, { recursive: true });

  cpSync(appPath, path.join(stageBundleDir, `${productName}.app`), { recursive: true });
  symlinkSync("/Applications", path.join(stageBundleDir, "Applications"));

  console.log(`Creating DMG at ${dmgPath}...`);
  run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stageBundleDir,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);

  console.log("");
  console.log("Artifacts:");
  console.log(`- App: ${appPath}`);
  console.log(`- DMG: ${dmgPath}`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
