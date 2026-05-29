# das-codegrep-mcp

> Local-first MCP server for NixOS-WSL nix-cfg workflows.
> Zoekt trigram search + pre-ingress code guardian + pre-commit hook gate.

[![version](https://img.shields.io/badge/version-v0.1.0-blue)](https://github.com/RyzeNGrind/das-codegrep-mcp/releases)

## Immediate test

```bash
git pull --ff-only
nix develop
./bin/dev-up && ./bin/install-hooks && ./bin/validate
```

## One-liners

| Task | Command |
|------|---------|
| Enter devshell | `nix develop` |
| Start Zoekt | `./bin/dev-up` |
| Install hooks | `./bin/install-hooks` |
| Full validate | `./bin/validate` |
| Index nix-cfg | `zoekt-index -index ~/.local/share/das-codegrep-mcp/index ~/code/nix-cfg` |
| Direct search | `zoekt 'mkIf lang:nix'` |
| Secret scan | `gitleaks dir . --no-banner` |
| SAST | `semgrep scan --config auto .` |
| Structural search | `sg run -p 'mkIf $A $B' .` |

## MCP tools

| Tool | Purpose |
|------|---------|
| `search_code` | Trigram search (lang:nix, f:*.nix, regex) |
| `index_directory` | Build/update Zoekt index |
| `guard_code` | Scan snippet before writing to workspace |
| `guard_file` | Scan existing file |
| `search_file` | Filename/glob search |
| `read_file` | Read file with optional line range |
| `list_index` | List indexed repos |
| `zoekt_status` | Health check |

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

## Semantic release

```bash
git tag -a v0.1.0 -m 'v0.1.0' && git push origin master --tags
```
