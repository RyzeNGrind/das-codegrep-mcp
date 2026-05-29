# das-codegrep-mcp

> Local-first MCP server for NixOS-WSL nix-cfg workflows.
> Zoekt trigram search + pre-ingress code guardian + pre-commit hook gate.

[![version](https://img.shields.io/badge/version-v0.1.0-blue)][releases]

[releases]: https://github.com/RyzeNGrind/das-codegrep-mcp/releases

## Immediate test flow

```bash
git clone https://github.com/RyzeNGrind/das-codegrep-mcp && cd das-codegrep-mcp
nix develop
./bin/dev-up && ./bin/install-hooks && ./bin/validate
```

That is the entire validation loop — all checks deterministic inside the devshell.

## One-liners

| Task | Command |
|------|---------|
| Enter devshell | `nix develop` |
| Start Zoekt | `./bin/dev-up` |
| Install hooks | `./bin/install-hooks` |
| Full validate | `./bin/validate` |
| Index nix-cfg | `zoekt-index -index ~/.local/share/das-codegrep-mcp/index ~/code/nix-cfg` |
| Direct search | `zoekt 'mkIf lang:nix'` |
| Guard snippet | send `guard_code` tool call via MCP client |
| Secret scan | `gitleaks dir . --no-banner` |
| SAST scan | `semgrep scan --config auto .` |

## MCP tools

| Tool | Purpose |
|------|---------|
| `search_code` | Trigram search across indexed repos (`lang:nix`, `f:*.nix`, regex) |
| `index_directory` | Build/update Zoekt index for directories |
| `guard_code` | Scan snippet before writing to workspace |
| `guard_file` | Scan existing file |
| `search_file` | Filename/glob search |
| `read_file` | Read file with optional line range |
| `list_index` | List indexed repos |
| `zoekt_status` | Health check |

## Tool stack

- **Zoekt** — fast trigram code search engine (Sourcegraph-maintained)
- **Semgrep OSS** — local static analysis / SAST
- **Gitleaks** — secrets scanning across git/dirs/stdin
- **TruffleHog** — verified secret scanning
- **ast-grep** — AST-based structural search, lint, rewrite
- **Comby** — syntax-aware structural search/replace
- **Lefthook** — fast parallel git hook orchestration
- **statix** — Nix linter / anti-pattern checker
- **nixpkgs-fmt** — canonical Nix formatter
- **nil** — Nix LSP

## NixOS module

```nix
{
  inputs.das-codegrep-mcp.url = "github:RyzeNGrind/das-codegrep-mcp";

  outputs = { self, nixpkgs, das-codegrep-mcp, ... }: {
    nixosConfigurations.nixos-wsl = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        das-codegrep-mcp.nixosModules.das-codegrep-mcp
        {
          services.dasCodegrepMcp = {
            enable    = true;
            indexDirs = [ "/home/nixos/code/nix-cfg" ];
            port      = 6070;
          };
        }
      ];
    };
  };
}
```

## Home Manager / NixOS-WSL

```nix
{
  imports = [ inputs.das-codegrep-mcp.homeManagerModules.default ];

  services.dasCodegrepMcp = {
    enable    = true;
    package   = inputs.das-codegrep-mcp.packages.${pkgs.system}.default;
    indexDirs = [ "${config.home.homeDirectory}/code/nix-cfg" ];
  };
}
```

## VSCodium / VS Code MCP registration

See `.vscode/mcp.json`.

## Semantic releases

```bash
git tag -a v0.1.0 -m 'v0.1.0'
git push origin main --tags
```

Conventional commits used in this repo: see `commit-plan.txt`.
