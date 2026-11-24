{
  description = "Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nix-darwin.url = "github:LnL7/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew = {
      url = "github:zhaofengli/nix-homebrew/de7953a0";
      inputs.brew-src.url = "github:Homebrew/brew/6.0.15";
    };

    homebrew-arimxyer-tap = {
      url = "github:arimxyer/homebrew-tap";
      flake = false;
    };
    homebrew-oven-sh-bun = {
      url = "github:oven-sh/homebrew-bun";
      flake = false;
    };
    homebrew-anomalyco-tap = {
      url = "github:anomalyco/homebrew-tap";
      flake = false;
    };
    homebrew-basecamp-tap = {
      url = "github:basecamp/homebrew-tap";
      flake = false;
    };

    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    # The markdown crates, pinned as a plain source tree: the repo carries no
    # flake.nix, and flake.lock holds the rev, so `nix flake update` bumps it.
    md-for-agents = {
      url = "github:vadirn/md-for-agents";
      flake = false;
    };
  };

  outputs = inputs @ {
    self,
    nixpkgs,
    nix-darwin,
    nix-homebrew,
    home-manager,
    ...
  }: let
    system = "aarch64-darwin";
    pkgs = nixpkgs.legacyPackages.${system};
    inherit (pkgs) lib;
    # `vault-query` is the only crate in the root workspace. Its build source is the
    # workspace manifest, the single lockfile, and its own tree; `mdstruct` and
    # `mdsearch` arrive as git dependencies that `fetchCargoVendor` resolves.
    workspaceFiles = lib.fileset.unions [
      ./Cargo.toml
      ./Cargo.lock
      ./vault-query/Cargo.toml
      ./vault-query/src
      ./vault-query/tests
    ];
    # Two files outside the workspace, carried by `vault-query` ALONE: the vault
    # skill's lint rosters. `vault-query/tests/roster.rs` reads them during
    # `checkPhase` and asserts they list exactly the rules `registry::rule_names()`
    # returns, so they have to be in that crate's build sandbox. Listing them file
    # by file rather than naming the skill directory keeps an unrelated skill edit
    # from rebuilding the crate.
    rosterDocs = lib.fileset.unions [
      ./home/agents/skills/vault/SKILL.md
      ./home/agents/skills/vault/references/lint.md
    ];
    # Use cargoHash (fetchCargoVendor) instead of cargoLock.lockFile
    # (importCargoLock). The latter fetches each crate via raw curl, and
    # crates.io's legacy /api/v1 endpoint 403s on curl's default User-Agent.
    # fetchCargoVendor runs `cargo vendor` inside the FOD; cargo's own UA is
    # accepted.
    vault-query = pkgs.rustPlatform.buildRustPackage {
      pname = "vault-query";
      version = "0.1.0";
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [workspaceFiles rosterDocs];
      };
      cargoHash = "sha256-ksQVMViwjNXKSDLtowqy82J/3W6mhT2vHu1HzPd6HmA=";
    };
    # `hooky`, the Claude Code hook router, is its own workspace with its own
    # lockfile: a hooky edit never rebuilds vault-query, and vault-query's
    # dependencies never reach the binary that sits on every tool call. The
    # build runs its tests, which use only `bash` and `/bin/sh` fixtures.
    hooky = pkgs.rustPlatform.buildRustPackage {
      pname = "hooky";
      version = "0.1.0";
      src = lib.fileset.toSource {
        root = ./hooky;
        fileset = lib.fileset.unions [
          ./hooky/Cargo.toml
          ./hooky/Cargo.lock
          ./hooky/src
          ./hooky/tests
        ];
      };
      cargoHash = "sha256-NmeRkk32/k1GNelrK5o+DK5aSi4DOXDuFO3tAvsVXFM=";
    };
    # `hooky-console`, the Rune window onto hooky's log and handlers, as
    # `Hooky Console.app`. Its own workspace and lockfile, like hooky; Rune and
    # its patched crates arrive as git dependencies that fetchCargoVendor
    # resolves. The bundle loads only system libraries, so a copy taken out of
    # the store (to sign it with a Developer ID, scripts/sign-hooky-console.sh)
    # keeps working after the store path is collected.
    hooky-console = pkgs.rustPlatform.buildRustPackage {
      pname = "hooky-console";
      version = "0.1.0";
      src = lib.fileset.toSource {
        root = ./hooky-console;
        fileset = lib.fileset.unions [
          ./hooky-console/Cargo.toml
          ./hooky-console/Cargo.lock
          ./hooky-console/src
        ];
      };
      cargoHash = "sha256-RyiN9f7G870ggE+ML4joo7/Y9L/VOms/p6ZCg9bB9I8=";
      nativeBuildInputs = [pkgs.darwin.sigtool];
      postInstall = ''
        app="$out/Applications/Hooky Console.app/Contents"
        mkdir -p "$app/MacOS"
        mv $out/bin/hooky-console "$app/MacOS/hooky-console"
        ln -s "../Applications/Hooky Console.app/Contents/MacOS/hooky-console" $out/bin/hooky-console
        exe="$app/MacOS/hooky-console"
        # Rust's libc crate links libiconv; nixpkgs points it at its own copy.
        # macOS ships the same ABI in /usr/lib.
        for lib in $(otool -L "$exe" | awk '/\/nix\/store\/.*libiconv/ {print $1}'); do
          install_name_tool -change "$lib" /usr/lib/libiconv.2.dylib "$exe"
        done
        if otool -L "$exe" | tail -n +2 | grep -q /nix/store; then
          echo "hooky-console still loads from /nix/store:" >&2
          otool -L "$exe" >&2
          exit 1
        fi
        codesign --force --sign - "$exe"
        # The icon: hooky-console/icon/AppIcon.icon (Icon Composer), compiled
        # by scripts/hooky-console-icon.sh into Assets.car, the Liquid Glass
        # icon macOS 26 and later draw, and AppIcon.icns for older systems.
        mkdir -p "$app/Resources"
        cp ${./hooky-console/icon/Assets.car} "$app/Resources/Assets.car"
        cp ${./hooky-console/icon/AppIcon.icns} "$app/Resources/AppIcon.icns"
        cat > "$app/Info.plist" <<EOF
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleExecutable</key><string>hooky-console</string>
          <key>CFBundleIconFile</key><string>AppIcon</string>
          <key>CFBundleIconName</key><string>AppIcon</string>
          <key>CFBundleIdentifier</key><string>io.vadirn.hooky-console</string>
          <key>CFBundleName</key><string>Hooky Console</string>
          <key>CFBundlePackageType</key><string>APPL</string>
          <key>CFBundleShortVersionString</key><string>0.1.0</string>
          <key>CFBundleVersion</key><string>0.1.0</string>
          <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
          <key>NSHighResolutionCapable</key><true/>
        </dict>
        </plist>
        EOF
      '';
    };
    # The hooky wiring checks, one per harness: a settings file that wires
    # hooks hooky does not generate fails them. home.checks runs them on
    # switch, and `checks` below runs them in CI before a merge.
    hookyWiring = import ./home/hooky-wiring.nix {inherit pkgs hooky;};
    # The extracted workspace builds as one derivation carrying every binary in
    # it, so comrak compiles once instead of once per crate, and one cargoHash
    # covers the lot.
    md-for-agents = pkgs.rustPlatform.buildRustPackage {
      pname = "md-for-agents";
      version = "0.1.0";
      src = inputs.md-for-agents;
      cargoHash = "sha256-DpYD0DfSvUkOVp9yXZM30d9IAIYkDHuOnjs7qp2RvTY=";
    };
    # Function to create configuration for any hostname
    mkDarwinConfig = hostname:
      nix-darwin.lib.darwinSystem {
        inherit system;
        specialArgs = {inherit inputs self vault-query md-for-agents hostname;};
        modules = [
          ./hosts/darwin.nix
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
          (import ./home {
            username = "vadim";
            homeDirectory = "/Users/vadim";
            inherit vault-query md-for-agents hooky hooky-console hookyWiring;
          })
        ];
      };
  in {
    # Generate configuration for common hostnames
    darwinConfigurations = {
      default = mkDarwinConfig "default";
      vdrn-studio = mkDarwinConfig "vdrn-studio";
      vdrn-mbp = mkDarwinConfig "vdrn-mbp";
    };

    darwinPackages = self.darwinConfigurations.default.pkgs;
    packages.${system} = {inherit vault-query md-for-agents hooky hooky-console;};
    checks.${system} = lib.mapAttrs' (harness: lib.nameValuePair "hooky-wiring-${harness}") hookyWiring;
    formatter.${system} = pkgs.alejandra;
  };
}
