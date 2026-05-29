# Agenix GH PAT Setup for das-codegrep-mcp

Complete walkthrough to wire your GitHub PAT via agenix so it **never touches disk unencrypted** and is available in every shell and the optional systemd service.

## Prerequisites

Your host flake must have:

```nix
# flake.nix inputs
agenix = {
  url    = "github:ryantm/agenix";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

And in `nixosConfigurations.<host>.modules`:

```nix
inputs.agenix.nixosModules.default
inputs.das-codegrep-mcp.nixosModules.das-codegrep-mcp
```

## Step 1 — Get your host's SSH ed25519 public key

```bash
# NixOS generates host keys at boot — grab the ed25519 one:
cat /etc/ssh/ssh_host_ed25519_key.pub
# Output: ssh-ed25519 AAAA<base64> root@hostname
```

Copy the full `ssh-ed25519 AAAA...` string.

## Step 2 — Update secrets/secrets.nix

Edit `secrets/secrets.nix` in this repo (or in your host flake's secrets dir) and replace the placeholder:

```nix
pc-25 = "ssh-ed25519 AAAA<YOUR_ACTUAL_KEY_HERE>";
```

## Step 3 — Generate a new GitHub PAT

1. Go to <https://github.com/settings/tokens?type=beta> (fine-grained PAT)
2. Scopes: **Contents (read)**, **Metadata (read)**, **Starring (read)**
3. Copy the token — you only see it once.

## Step 4 — Encrypt the PAT with agenix

```bash
# From your flake root (where secrets/ lives):
agenix -e secrets/github-pat.age
# Your $EDITOR opens — paste the raw PAT (single line):
# ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Save and quit. File is now AES-256 encrypted.
```

## Step 5 — Enable the NixOS module in your host flake

```nix
# nixosConfigurations.pc-25.modules = [
#   ...
#   inputs.das-codegrep-mcp.nixosModules.das-codegrep-mcp
#   {
#     services.das-codegrep-mcp = {
#       enable    = true;
#       user      = "ryzengrind";
#       workspace = "/home/ryzengrind/Workspaces";
#       indexDir  = "/home/ryzengrind/.local/share/das-codegrep-mcp/index";
#       ghUser    = "RyzeNGrind";
#       # Optional: run as systemd user service
#       # enableSystemdService = true;
#     };
#   }
# ];
```

## Step 6 — Rebuild

```bash
sudo nixos-rebuild switch --flake .#pc-25
```

After rebuild:

- `/run/agenix/github-pat` exists (tmpfs, root-encrypted at boot)
- `/etc/profile.d/das-codegrep-mcp-pat.sh` exports `DAS_GH_TOKEN` from it
- Every new shell session has `DAS_GH_TOKEN` set automatically

## Step 7 — Verify

```bash
# New terminal (or: source /etc/profile.d/das-codegrep-mcp-pat.sh)
echo $DAS_GH_TOKEN         # ghp_xxx...
echo $DAS_GH_USER          # RyzeNGrind
echo $DAS_WORKSPACE        # /home/ryzengrind/Workspaces

# Test GitHub API with the token
curl -s -H "Authorization: Bearer $DAS_GH_TOKEN" \
  https://api.github.com/user | jq .login
# Expected: "RyzeNGrind"

# Test starred search (once GitHub search tools are implemented)
curl -s -H "Authorization: Bearer $DAS_GH_TOKEN" \
  'https://api.github.com/search/code?q=vllm+language:Nix' \
  | jq '.total_count, .items[0].repository.full_name'
```

## .envrc integration (direnv fallback)

If you prefer not to rebuild NixOS just yet, `.envrc.example` Option A still works:

```bash
cp .envrc.example .envrc
# Uncomment: export DAS_GH_TOKEN="$(< /run/agenix/github-pat)"
direnv allow
```

This reads from the same agenix-decrypted file — same security, no config rebuild needed.

## Secret rotation

```bash
# Revoke old PAT on GitHub, create new one, then:
agenix -e secrets/github-pat.age   # overwrites in-place, re-encrypts
sudo nixos-rebuild switch --flake .#pc-25
# /run/agenix/github-pat is updated at next boot (or systemctl restart agenix)
```
