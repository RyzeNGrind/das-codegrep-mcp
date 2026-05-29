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
            # Node / TS runtime
            nodejs_22
            nodePackages.typescript
            nodePackages.ts-node

            # Zoekt — Sourcegraph-grade trigram code search
            zoekt

            # Guard stack
            semgrep
            gitleaks
            trufflehog
            ast-grep
            comby
            lefthook

            # Nix type-safety
            nixpkgs-fmt
            statix
            nil
          ];

          shellHook = ''
            echo "╔══════════════════════════════════════════════╗"
            echo "║  das-codegrep-mcp devshell                   ║"
            echo "║  zoekt:       $(which zoekt-index 2>/dev/null || echo MISSING)"
            echo "║  semgrep:     $(which semgrep 2>/dev/null || echo MISSING)"
            echo "║  gitleaks:    $(which gitleaks 2>/dev/null || echo MISSING)"
            echo "║  trufflehog:  $(which trufflehog 2>/dev/null || echo MISSING)"
            echo "║  lefthook:    $(which lefthook 2>/dev/null || echo MISSING)"
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
        nixosModules.das-codegrep-mcp   = import ./nix/module.nix;
        homeManagerModules.default       = import ./nix/home-manager.nix;
      };
    };
}
