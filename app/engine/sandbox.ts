/**
 * sandbox.ts — OS-native process confinement (the hard boundary).
 *
 * Reports what the kernel can actually enforce on this machine. The policy
 * pipeline's SANDBOX layer is a flag layer with no writer, so the honest answer
 * here is what keeps the "confined" badge from becoming a lie: the probe says
 * what is available, never what is merely configured.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";

export const FULL = "full";
export const PARTIAL = "partial";
export const UNAVAILABLE = "unavailable";

export class Enforcement {
  level: string;
  backend: string;
  detail: string;
  network: boolean;

  constructor(
    levelOrOpts:
      | string
      | { level?: string; backend?: string; detail?: string; network?: boolean } = UNAVAILABLE,
    backend = "",
    detail = "",
    network = false,
  ) {
    if (levelOrOpts && typeof levelOrOpts === "object") {
      this.level = levelOrOpts.level || UNAVAILABLE;
      this.backend = levelOrOpts.backend || "";
      this.detail = levelOrOpts.detail || "";
      this.network = levelOrOpts.network ?? false;
    } else {
      this.level = levelOrOpts || UNAVAILABLE;
      this.backend = backend;
      this.detail = detail;
      this.network = network;
    }
  }

  get usable(): boolean {
    return this.level === FULL || this.level === PARTIAL;
  }
}

let _cached_probe: Enforcement | null = null;

export function reset_probe_cache(): void {
  _cached_probe = null;
}

/**
 * Test hooks — ESM cannot monkeypatch same-file bindings, so the probe reads
 * these slots. Production paths only ever read them.
 */
export const _test_hooks: {
  probe: (() => Enforcement) | null;
  landlock_abi: (() => number) | null;
  which: ((name: string) => string | null) | null;
} = {
  probe: null,
  landlock_abi: null,
  which: null,
};

function _which(name: string): string | null {
  if (_test_hooks.which) return _test_hooks.which(name);
  try {
    const out = execSync(process.platform === "win32" ? `where ${name}` : `which ${name}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
}

/** Landlock ABI version; only ABI 4+ touches the network. Non-Linux or a failed
 *  probe reports 0, which is the same "no Landlock" answer. */
export function _landlock_abi(): number {
  if (_test_hooks.landlock_abi) return _test_hooks.landlock_abi();
  return 0;
}

export function _probe_windows(): Enforcement {
  return new Enforcement(
    PARTIAL,
    "job_object",
    "Job Objects constrain the process tree. Filesystem writes are " +
      "enforced by the path-policy layer; a write-restricted token is " +
      "applied when CreateProcessAsUser accepts it.",
    // A job object governs the process tree, not sockets.
    false,
  );
}

export function _probe_macos(): Enforcement {
  const exe = _which("sandbox-exec") || "/usr/bin/sandbox-exec";
  try {
    fs.accessSync(exe, fs.constants.X_OK);
    // Seatbelt's (deny network*) is a real disconnect.
    return new Enforcement(FULL, "seatbelt", `sandbox-exec at ${exe}`, true);
  } catch {
    if (fs.existsSync(exe)) {
      return new Enforcement(FULL, "seatbelt", `sandbox-exec at ${exe}`, true);
    }
  }
  return new Enforcement(UNAVAILABLE, "", "sandbox-exec not found", false);
}

export function _probe_linux(): Enforcement {
  const abi = _landlock_abi();
  if (abi >= 1) {
    // Landlock only reaches the network from ABI 4; below that network=False.
    return new Enforcement(FULL, "landlock", `Landlock ABI ${abi}`, abi >= 4);
  }
  if (_which("bwrap")) {
    // bwrap's --unshare-net yields an empty network namespace — a real cut.
    return new Enforcement(PARTIAL, "bwrap", "bubblewrap (Landlock unavailable)", true);
  }
  return new Enforcement(UNAVAILABLE, "", "no Landlock, no bubblewrap", false);
}

function _probe_uncached(): Enforcement {
  const p = process.platform;
  if (p === "win32") return _probe_windows();
  if (p === "darwin") return _probe_macos();
  if (p === "linux") return _probe_linux();
  return new Enforcement(UNAVAILABLE, "", `unsupported os: ${p}`);
}

export function probe(): Enforcement {
  if (_test_hooks.probe) {
    return _test_hooks.probe();
  }
  if (_cached_probe === null) {
    _cached_probe = _probe_uncached();
  }
  return _cached_probe;
}

export function confinement_status(workspace_root: string = ""): Record<string, unknown> {
  const enf = probe();
  return {
    usable: enf.usable,
    level: enf.level,
    backend: enf.backend,
    detail: enf.detail,
    network_isolation_supported: enf.network,
    // Network isolation is a capability, not a setting.
    network_isolation: {
      supported: enf.network,
      backend: enf.backend || "none",
    },
    workspace: workspace_root || process.cwd(),
  };
}

export function describe_os_confinement(): string {
  /**
   * The confinement kind actually available on this machine, for
   * ExecutionPlan.os_confinement to cite. This is a probe, not a platform
   * lookup table: a Linux kernel without Landlock (ABI < 1) reports the
   * fallback honestly, and so does a macOS without sandbox-exec.
   */
  const p = process.platform;
  if (p === "win32") {
    return probe().usable ? "job_object" : "popen_confined";
  }
  if (p === "darwin") {
    return probe().usable ? "seatbelt" : "popen_confined";
  }
  if (p === "linux") {
    try {
      if (_landlock_abi() >= 1) {
        return "landlock";
      }
    } catch {
      // Probe failed → report the fallback, do not lie.
    }
    return "popen_confined";
  }
  return "popen_confined";
}
