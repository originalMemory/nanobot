import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";

export const APP_ID = "ai.nanobot.desktop";
export const APP_NAME = "Nanobot";
export const APP_EXECUTABLE = "nanobot";
export const LOCAL_SIGN_IDENTITY = "Nanobot Local Code Signing";

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function selectSignIdentity({
  configured = process.env.NANOBOT_MAC_SIGN_IDENTITY?.trim(),
  identities,
  platform = process.platform,
} = {}) {
  if (configured) return configured;
  if (platform !== "darwin") return "-";
  let available = identities;
  if (available === undefined) {
    try {
      available = execFileSync(
        "/usr/bin/security",
        ["find-identity", "-v", "-p", "codesigning"],
        { encoding: "utf8" },
      );
    } catch {
      available = "";
    }
  }
  return available.includes(`"${LOCAL_SIGN_IDENTITY}"`) ? LOCAL_SIGN_IDENTITY : "-";
}

export function macPackageOptions({
  arch = process.env.NANOBOT_MAC_ARCH || process.arch,
  identity = selectSignIdentity(),
} = {}) {
  if (!["arm64", "x64", "universal"].includes(arch)) {
    throw new Error(`Unsupported macOS architecture: ${arch}`);
  }
  return {
    dir: electronDir,
    name: APP_NAME,
    executableName: APP_EXECUTABLE,
    platform: "darwin",
    arch,
    out: path.join(electronDir, "out"),
    overwrite: true,
    asar: true,
    prune: true,
    // Packager resolves the platform-specific extension (.icns on macOS).
    icon: path.join(electronDir, "assets", "icon"),
    appBundleId: APP_ID,
    helperBundleId: `${APP_ID}.helper`,
    appCategoryType: "public.app-category.productivity",
    extendInfo: path.join(electronDir, "Info.plist"),
    ignore: /^\/(out|out-build|dist|\.vite|test|scripts|README\.md|package-lock\.json)$/,
    osxSign: {
      identity,
      // The stable local certificate is intentionally self-signed, matching lover.
      identityValidation: false,
      continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
    },
  };
}

export async function packageMac() {
  if (process.platform !== "darwin") throw new Error("package:mac only supports macOS");
  const options = macPackageOptions();
  const paths = await packager(options);
  if (paths.length !== 1) throw new Error(`Expected one macOS app, received ${paths.length}`);
  process.stdout.write(`Packaged and signed (${options.osxSign.identity}): ${paths[0]}\n`);
  return paths[0];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageMac().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
