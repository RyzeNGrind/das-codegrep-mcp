{
  description = "das-codegrep-mcp — local-first Zoekt trigram MCP server for NixOS-WSL";

  inputs = {
    nixpkgs.url     = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url     = "github:nix-systems/default-linux";
  };

  outputs = inputs @ { flake-parts, systems, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import systems;

      perSystem = { pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          name = "das-codegrep-mcp";

          packages = with pkgs; [
            # Node / TS runtime  (nodePackages.* removed in nixos-unstable 2026-05)
            nodejs_22
            typescript          # was nodePackages.typescript
            nodePackages_latest.ts-node  # ts-node not yet promoted to top-level

            # Zoekt — Sourcegraph-grade trigram code search
            zoekt

            # Guard stack
            semgrep
            gitleaks
            # trufflehog and comby are intermittently absent on x86_64-linux unstable;
            # install via: nix profile install nixpkgs#trufflehog

            # Nix type-safety
            nixpkgs-fmt
            statix
            nil

            # Hooks
            lefthook

            # Structural search / patch
            ast-grep
          ];

          shellHook = ''
            # Fix execute bits lost by GitHub API (push_files has no mode support)
            chmod +x "$PWD"/bin/* 2>/dev/null || true

            echo "╔══════════════════════════════════════════════╗"
            echo "║  das-codegrep-mcp devshell                   ║"
            printf "║  nodejs:      %s\n" "$(which node 2>/dev/null || echo MISSING)"
            printf "║  typescript:  %s\n" "$(which tsc 2>/dev/null || echo MISSING)"
            printf "║  zoekt:       %s\n" "$(which zoekt-index 2>/dev/null || echo MISSING)"
            printf "║  semgrep:     %s\n" "$(which semgrep 2>/dev/null || echo MISSING)"
            printf "║  gitleaks:    %s\n" "$(which gitleaks 2>/dev/null || echo MISSING)"
            printf "║  lefthook:    %s\n" "$(which lefthook 2>/dev/null || echo MISSING)"
            printf "║  ast-grep:    %s\n" "$(which sg 2>/dev/null || echo MISSING)"
            printf "║  nil(lsp):    %s\n" "$(which nil 2>/dev/null || echo MISSING)"
            echo "╚══════════════════════════════════════════════╝"

            export DAS_INDEX_DIR="''${DAS_INDEX_DIR:-$HOME/.local/share/das-codegrep-mcp/index}"
            mkdir -p "$DAS_INDEX_DIR"
            echo "quick-start: ./bin/dev-up && ./bin/install-hooks && ./bin/validate"
          '';
        };

        packages.default = pkgs.writeShellScriptBin "das-codegrep-mcp" ''
          exec ${pkgs.nodejs_22}/bin/node "$(dirname "$0")/../lib/das-codegrep-mcp/dist/index.js" "$@"
        '';
      };

      flake = {
        nixosModules.das-codegrep-mcp = import ./nix/module.nix;
        homeManagerModules.default     = import ./nix/home-manager.nix;
      };
    };
}
