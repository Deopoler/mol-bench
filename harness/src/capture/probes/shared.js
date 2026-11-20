import crypto from 'node:crypto';
import { PNG } from 'pngjs';

/**
 * Decode a PNG Buffer into { width, height, data } (RGBA Uint8Array).
 */
export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Compute SHA-256 hex digest of decoded RGBA pixels of a PNG Buffer.
 */
export function pixelSha256(pngBuffer) {
  const { data } = decodePng(pngBuffer);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute mean absolute difference (in [0, 1]) between two PNG Buffers (RGB channels).
 * Returns 1.0 if dimensions mismatch.
 */
export function pngMeanAbsDiff(bufA, bufB) {
  const a = decodePng(bufA);
  const b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height) return 1.0;
  const n = a.width * a.height;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (n * 3 * 255);
}

/**
 * WCAG 2.1 relative luminance for 8-bit sRGB channels.
 */
export function relativeLuminance(r8, g8, b8) {
  const toLinear = (c8) => {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r8) + 0.7152 * toLinear(g8) + 0.0722 * toLinear(b8);
}

/**
 * WCAG 2.1 contrast ratio between two 8-bit RGB colors.
 */
export function wcagContrast(r1, g1, b1, r2, g2, b2) {
  const l1 = relativeLuminance(r1, g1, b1);
  const l2 = relativeLuminance(r2, g2, b2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Compute median of a numeric array. Returns null if empty.
 */
export function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
