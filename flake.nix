{
  description = "das-codegrep-mcp \u2014 local-first Zoekt trigram MCP server for NixOS-WSL";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default-linux";

    # agenix \u2014 age-encrypted secrets for NixOS
    agenix = {
      url = "github:ryantm/agenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      flake-parts,
      systems,
      agenix,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import systems;

      perSystem =
        { pkgs, ... }:
        {
          devShells.default = pkgs.mkShell {
            name = "das-codegrep-mcp";

            packages = with pkgs; [
              # Node / TS runtime
              nodejs_22
              typescript

              # Zoekt \u2014 offline trigram search
              zoekt

              # agenix CLI for secret editing
              agenix.packages.${pkgs.system}.default

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

              echo "\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557"
              echo "\u2551  das-codegrep-mcp devshell ready              \u2551"
              echo "\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d"
              printf '  node      %s\n' "$(node --version 2>/dev/null || echo MISSING)"
              printf '  tsc       %s\n' "$(tsc --version 2>/dev/null || echo MISSING)"
              printf '  zoekt     %s\n' "$(which zoekt-index 2>/dev/null || echo MISSING)"
              printf '  semgrep   %s\n' "$(which semgrep 2>/dev/null || echo MISSING)"
              printf '  gitleaks  %s\n' "$(which gitleaks 2>/dev/null || echo MISSING)"
              printf '  lefthook  %s\n' "$(which lefthook 2>/dev/null || echo MISSING)"
              printf '  sg        %s\n' "$(which sg 2>/dev/null || echo MISSING)"
              printf '  nil       %s\n' "$(which nil 2>/dev/null || echo MISSING)"
              printf '  agenix    %s\n' "$(which agenix 2>/dev/null || echo MISSING)"

              export DAS_INDEX_DIR="''${DAS_INDEX_DIR:-$HOME/.local/share/das-codegrep-mcp/index}"
              mkdir -p "$DAS_INDEX_DIR"

              # Load GH PAT from agenix secret if available (read-only, no disk write)
              if [ -r /run/agenix/github-pat ]; then
                export DAS_GH_TOKEN="$(< /run/agenix/github-pat)"
                echo "[das-codegrep] DAS_GH_TOKEN loaded from agenix secret"
              elif [ -n "$DAS_GH_TOKEN" ]; then
                echo "[das-codegrep] DAS_GH_TOKEN loaded from environment"
              else
                echo "[das-codegrep] WARN: DAS_GH_TOKEN not set \u2014 GitHub search disabled"
              fi

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
        # NixOS system module (agenix + systemd service + session vars)
        nixosModules.das-codegrep-mcp = import ./nix/modules/das-codegrep-mcp.nix;

        # Home-manager module (user-level, no agenix required)
        homeManagerModules.default = import ./nix/home-manager.nix;
      };
    };
}
