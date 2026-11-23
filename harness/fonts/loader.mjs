/**
 * Deterministic OFL font manifest & loader for MoL-Bench v0.2 web rooms.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FONTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FONT_MANIFEST_PATH = path.join(FONTS_DIR, "manifest.json");
export const FONT_CSS_PATH = path.join(FONTS_DIR, "fonts.css");

export function getFontManifest(fontsDir = FONTS_DIR) {
  const manifestPath = path.join(fontsDir, "manifest.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Verify that all declared OFL font binaries and license files are present and match sha256 (when pinned).
 */
export function verifyVendoredFonts(fontsDir = FONTS_DIR) {
  const manifest = getFontManifest(fontsDir);
  const missingFonts = [];
  const missingLicenses = [];
  const hashMismatches = [];
  const presentFonts = [];

  for (const font of manifest.fonts || []) {
    const fontPath = path.join(fontsDir, font.file);
    if (!fs.existsSync(fontPath)) {
      missingFonts.push(font.file);
    } else {
      const actualHash = sha256File(fontPath);
      presentFonts.push({ family: font.family, file: font.file, sha256: actualHash });
      if (font.sha256 && font.sha256 !== actualHash) {
        hashMismatches.push({ file: font.file, expected: font.sha256, actual: actualHash });
      }
    }
    if (font.license_file) {
      const licPath = path.join(fontsDir, font.license_file);
      if (!fs.existsSync(licPath)) {
        missingLicenses.push(font.license_file);
      }
    }
  }

  return {
    complete: missingFonts.length === 0 && missingLicenses.length === 0 && hashMismatches.length === 0,
    status: manifest.status,
    presentFonts,
    missingFonts,
    missingLicenses,
    hashMismatches
  };
}

/**
 * Copy fonts.css, manifest.json, and any vendored font/license files into a room's fonts directory.
 */
export function copyFontsTo(destDir, fontsDir = FONTS_DIR) {
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  const manifest = getFontManifest(fontsDir);
  const files = new Set(["fonts.css", "manifest.json"]);
  for (const font of manifest.fonts || []) {
    if (font.file) files.add(font.file);
    if (font.license_file) files.add(font.license_file);
  }
  for (const name of files) {
    const src = path.join(fontsDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, name));
      copied.push(name);
    }
  }
  return copied;
}
