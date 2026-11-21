/**
 * Public self-check tests for room `atelier` (`rooms/atelier/seed/public-tests/basic.mjs`).
 */

import fs from "node:fs";
import path from "node:path";

export default [
  {
    id: "deliverables-exist",
    title: "build.py, out/lantern.glb, and out/lantern.blend exist",
    async run(ctx) {
      const req = ["build.py", "out/lantern.glb", "out/lantern.blend"];
      const missing = req.filter((rel) => !fs.existsSync(path.join(ctx.submissionDir, rel)));
      return {
        pass: missing.length === 0,
        detail: missing.length === 0 ? "all required files exist" : `missing: ${missing.join(", ")}`
      };
    }
  },
  {
    id: "hierarchy-present",
    title: "Required Lantern part hierarchy is present",
    async run(ctx) {
      const h = ctx.metrics?.["scene.hierarchy"];
      const ok = h && h.passed === h.total && h.total > 0;
      return {
        pass: Boolean(ok),
        detail: h ? `${h.passed}/${h.total} hierarchy nodes matched` : "hierarchy not evaluated"
      };
    }
  }
];
