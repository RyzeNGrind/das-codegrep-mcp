{
  description = "das-codegrep-mcp — local-first Zoekt trigram MCP server for NixOS-WSL";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default-linux";
  };

  outputs =
    inputs@{ flake-parts, systems, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import systems;

      perSystem =
        { pkgs, ... }:
        {
          devShells.default = pkgs.mkShell {
            name = "das-codegrep-mcp";

            packages = with pkgs; [
              # Node / TS runtime
              # nodePackages.* fully removed nixos-unstable 2026-05
              # ts-node: use npx (installed via npm devDependencies)
              nodejs_22
              typescript

              # Zoekt — offline trigram search
              zoekt

              # Static analysis / secret scanning
              semgrep
              gitleaks
              ast-grep

              # Nix tooling
              nixpkgs-fmt
              statix
              nil

              # Git hooks
              lefthook

              # Shell utils
              jq
              ripgrep
              fd
            ];

            shellHook = ''
              chmod +x "$PWD"/bin/* 2>/dev/null || true

              echo "╔══════════════════════════════════════════════╗"
              echo "║  das-codegrep-mcp devshell ready              ║"
              echo "╚══════════════════════════════════════════════╝"
              printf '  node      %s\n' "$(node --version 2>/dev/null || echo MISSING)"
              printf '  tsc       %s\n' "$(tsc --version 2>/dev/null || echo MISSING)"
              printf '  zoekt     %s\n' "$(which zoekt-index 2>/dev/null || echo MISSING)"
              printf '  semgrep   %s\n' "$(which semgrep 2>/dev/null || echo MISSING)"
              printf '  gitleaks  %s\n' "$(which gitleaks 2>/dev/null || echo MISSING)"
              printf '  lefthook  %s\n' "$(which lefthook 2>/dev/null || echo MISSING)"
              printf '  sg        %s\n' "$(which sg 2>/dev/null || echo MISSING)"
              printf '  nil       %s\n' "$(which nil 2>/dev/null || echo MISSING)"

              export DAS_INDEX_DIR="''${DAS_INDEX_DIR:-$HOME/.local/share/das-codegrep-mcp/index}"
              mkdir -p "$DAS_INDEX_DIR"

              if [ ! -d "$PWD/src/node_modules" ]; then
                echo "[das-codegrep] npm install (first run)..."
                (cd "$PWD/src" && npm install --ignore-scripts --no-fund --no-audit --silent)
              fi

              echo "quick-start: ./bin/dev-up && ./bin/install-hooks && ./bin/validate"
            '';
          };

          packages.default = pkgs.writeShellScriptBin "das-codegrep-mcp" ''
            exec ${pkgs.nodejs_22}/bin/node "$(dirname "$0")/../lib/das-codegrep-mcp/dist/index.js" "$@"
          '';
        };

      flake = {
        nixosModules.das-codegrep-mcp = import ./nix/module.nix;
        homeManagerModules.default = import ./nix/home-manager.nix;
      };
    };
}
