# Every hook a harness's settings wire goes through hooky: their hooks block
# must be what hooky generates from that harness's handler list,
# home/<harness>/hooky/hooks.json (README, hooky). A hook wired into the
# settings directly, or a handler change not applied there, fails this check.
# flake.nix runs it twice from this one definition: as a flake check, which
# the `hooky wiring` workflow builds on each pull request touching its inputs,
# and as a home-manager check, which fails the switch.
{
  pkgs,
  hooky,
}:
builtins.mapAttrs (harness: settings:
    pkgs.runCommand "hooky-wiring-${harness}" {nativeBuildInputs = [pkgs.jq];} ''
      ${hooky}/bin/hooky --harness ${harness} \
        --config ${./. + "/${harness}/hooky/hooks.json"} \
        settings --bin "~/.local/bin/hooky" | jq -S .hooks > want
      jq -S .hooks ${./. + "/${harness}/${settings}"} > have
      if ! diff -u want have >&2; then
        echo "home/${harness}/${settings} wires hooks that hooky does not generate from home/${harness}/hooky/hooks.json." >&2
        echo "Put the handler in that hooks.json, then run from the repo root:" >&2
        echo "  hooky --harness ${harness} --config home/${harness}/hooky/hooks.json install --settings home/${harness}/${settings}" >&2
        exit 1
      fi
      touch $out
    '') {
  claude = "settings.json";
  codex = "hooks.json";
}
