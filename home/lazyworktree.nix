{
  lib,
  stdenv,
  buildGoModule,
  fetchFromGitHub,
  installShellFiles,
  versionCheckHook,
}:
# Vendored from nixpkgs (pkgs/by-name/la/lazyworktree/package.nix). The package
# is not in nixos-25.11, only nixos-unstable, so we pin the derivation here.
# Hashes are the upstream nixpkgs values for v1.46.0 and are reproducible.
# To bump: change `version`, then update `hash` and `vendorHash` from the build error.
let
  version = "1.46.0";
in
  buildGoModule {
    pname = "lazyworktree";
    inherit version;

    src = fetchFromGitHub {
      owner = "chmouel";
      repo = "lazyworktree";
      rev = "v${version}";
      hash = "sha256-1XDFvfvMNJhrLvDmXgQGXqlfY5n1pZLz9LO3sGVyk3k=";
    };

    vendorHash = "sha256-el3fHFqOzt+Yjgo+tB6/sdBu1qzkWBSB9rHh+h9QbJY=";

    nativeBuildInputs = [installShellFiles];

    # Tests require git and are integration tests.
    doCheck = false;

    ldflags = [
      "-s"
      "-w"
      "-X main.version=${version}"
    ];

    postInstall =
      ''
        install -Dm444 shell/functions.{bash,fish,zsh} -t $out/share/lazyworktree
        installManPage lazyworktree.1
      ''
      + lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
        installShellCompletion --cmd lazyworktree \
          --bash <($out/bin/lazyworktree completion bash --code) \
          --zsh <($out/bin/lazyworktree completion zsh --code) \
          --fish <($out/bin/lazyworktree completion fish --code)
      '';

    doInstallCheck = true;
    nativeInstallCheckInputs = [versionCheckHook];

    meta = {
      description = "BubbleTea-based Terminal User Interface for efficient Git worktree management";
      homepage = "https://github.com/chmouel/lazyworktree";
      changelog = "https://github.com/chmouel/lazyworktree/releases/tag/v${version}";
      license = lib.licenses.asl20;
      mainProgram = "lazyworktree";
    };
  }
