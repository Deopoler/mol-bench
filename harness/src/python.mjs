import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function findPythonExecutable(repoRoot) {
  const winVenv = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winVenv)) return winVenv;
  const unixVenv = path.join(repoRoot, ".venv", "bin", "python");
  if (fs.existsSync(unixVenv)) return unixVenv;
  return "python";
}

/**
 * Execute Python with `-B`, `PYTHONDONTWRITEBYTECODE=1`, and a fresh temp
 * `PYTHONPYCACHEPREFIX` outside any submission/work directory so pre-planted
 * `.pyc` files inside `__pycache__/` are never loaded or executed.
 */
export function execSafePythonSync(repoRoot, args, options = {}) {
  const py = findPythonExecutable(repoRoot);
  const pycacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-pycache-"));
  const env = {
    ...process.env,
    ...(options.env || {}),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: pycacheDir
  };
  try {
    return execFileSync(py, ["-B", ...args], {
      ...options,
      env
    });
  } finally {
    try {
      fs.rmSync(pycacheDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
}
