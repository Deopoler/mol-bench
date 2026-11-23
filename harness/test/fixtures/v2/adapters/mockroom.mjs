import { emitFrames, emitProbes } from "../../../../src/registry.mjs";

export const room = "mockroom";

export function registerMetrics() {
  return {
    "mock.probe_elements": {
      source: "probe",
      needs: (m, ctx) => emitProbes("mock_probe", m, ctx)
    },
    "mock.py_mean_blue": {
      source: "python",
      needs: (m, ctx) => emitFrames(m, ctx)
    },
    "mock.adapter_bonus": {
      source: "room",
      needs: () => []
    },
    "mock.info_diag": {
      source: "room",
      needs: () => []
    }
  };
}

export function generate(seed, { hidden = false } = {}) {
  return { seed, hidden, accent: "#1040c0" };
}

export async function extraMetrics(_ctx, rawMetrics) {
  rawMetrics["mock.adapter_bonus"] = true;
  rawMetrics["mock.info_diag"] = null;
}
