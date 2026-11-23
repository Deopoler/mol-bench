// restoration v0.2 room adapter — public loader.
// The real adapter names every planted bug's mechanism, so it lives with the other grading
// secrets in hidden-v2/restoration/adapter.mjs (gitignored, local to the grading machine).
// Without it the room can be listed but not graded.
export const room = "restoration";

const notAvailable = (name) => () => {
  throw new Error(`restoration v0.2: ${name} needs hidden-v2/restoration/adapter.mjs (grading material is not in the public repo)`);
};
const NAMES = [
  "registerMetrics", "mulberry32", "generate", "runPlanetariumBrowserProbes", "extraCapture",
  "detectVariantSeedAndBugs", "stripJsCommentsAndBlankLines", "countChangedLines", "computeDiffMetrics",
  "scanRegressionTestsSandbox", "evaluateRedGreenVerifiedTests", "diffDenominator", "extraMetrics"
];

let hidden = null;
try {
  hidden = await import(new URL("../../../hidden-v2/restoration/adapter.mjs", import.meta.url).href);
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
}

export const available = Boolean(hidden);
export const RESTORATION_V2_METRICS = hidden?.RESTORATION_V2_METRICS ?? Object.freeze({});
const pick = (n) => (hidden && typeof hidden[n] === "function" ? hidden[n] : notAvailable(n));
export const registerMetrics = hidden ? hidden.registerMetrics : () => ({});
export const mulberry32 = pick("mulberry32");
export const generate = pick("generate");
export const runPlanetariumBrowserProbes = pick("runPlanetariumBrowserProbes");
export const extraCapture = pick("extraCapture");
export const detectVariantSeedAndBugs = pick("detectVariantSeedAndBugs");
export const stripJsCommentsAndBlankLines = pick("stripJsCommentsAndBlankLines");
export const countChangedLines = pick("countChangedLines");
export const computeDiffMetrics = pick("computeDiffMetrics");
export const scanRegressionTestsSandbox = pick("scanRegressionTestsSandbox");
export const evaluateRedGreenVerifiedTests = pick("evaluateRedGreenVerifiedTests");
export const diffDenominator = pick("diffDenominator");
export const extraMetrics = pick("extraMetrics");
void NAMES;
