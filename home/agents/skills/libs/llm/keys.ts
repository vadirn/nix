// keys — resolve each provider's API key at first use, cached per process.
//
// The transport is multi-provider (Fireworks / OpenAI / qwencloud), and each provider's
// key lives in a different place. This module centralizes that lookup so the CLI wrappers
// stay trivial (`exec bun …`) and no key-sourcing logic is duplicated in bash. Resolution
// order per provider: an already-exported env var wins (a wrapper, a test, or `doppler run`
// that pre-set it); else the macOS Keychain service; else the Doppler secret. The resolved
// value is written back to `process.env` so a second lookup — and any child process — is free.
//
// A key that resolves nowhere throws MissingKeyError; a CLI catches it up front (via
// ensureKeys) and exits 1 with an actionable message, preserving the old missing-key path.

// Where a provider's key can be found. `env` is both the variable checked first and the
// cache target. `keychain` names a `security find-generic-password -s <service>` entry;
// `doppler` names a secret in a project/config. A provider may declare either or both; when
// both are set they form a fallback chain — keychain wins, doppler covers a machine that
// lacks the keychain entry (e.g. Fireworks is seeded locally but falls back to Doppler).
export type KeySource = {
  env: string;
  keychain?: string;
  doppler?: { secret: string; project: string; config: string };
};

// A key that could not be resolved from any declared source. Not a TransientError — a
// missing key fails identically on retry, so it must surface (exit 1), never degrade.
export class MissingKeyError extends Error {
  override readonly name = "MissingKeyError";
}

// One shell-out, trimmed; null on any non-zero exit or empty output so the caller falls
// through to the next source. Sync on purpose: key resolution is a one-time startup step,
// and a synchronous call keeps callProvider's async path free of a resolution await.
function run(cmd: string[]): string | null {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out.length ? out : null;
  } catch {
    return null; // binary absent (no `security`/`doppler` on PATH) — try the next source
  }
}

// Resolve one provider's key, caching the result into its env var. Returns the key or
// throws MissingKeyError naming every source that was tried. Set LLM_KEYS_ENV_ONLY=1 to
// resolve from the env var alone (no Keychain/Doppler shell-out) — the hermetic seam tests
// use so a "missing key" case fails deterministically instead of being satisfied by a real
// Doppler entry.
export function resolveKey(src: KeySource): string {
  const cached = process.env[src.env];
  if (cached && cached.length) return cached;
  if (process.env.LLM_KEYS_ENV_ONLY === "1") {
    throw new MissingKeyError(`no API key for ${src.env} (env-only mode; ${src.env} unset)`);
  }

  const fromKeychain = src.keychain
    ? run(["security", "find-generic-password", "-s", src.keychain, "-w"])
    : null;
  const fromDoppler =
    !fromKeychain && src.doppler
      ? run([
          "doppler",
          "secrets",
          "get",
          src.doppler.secret,
          "--plain",
          "--project",
          src.doppler.project,
          "--config",
          src.doppler.config,
        ])
      : null;

  const key = fromKeychain ?? fromDoppler;
  if (!key) {
    const tried = [
      `env ${src.env}`,
      src.keychain ? `Keychain '${src.keychain}'` : null,
      src.doppler
        ? `Doppler ${src.doppler.project}/${src.doppler.config}:${src.doppler.secret}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new MissingKeyError(`no API key for ${src.env} — tried: ${tried}`);
  }
  process.env[src.env] = key; // cache for the transport and any child process
  return key;
}
