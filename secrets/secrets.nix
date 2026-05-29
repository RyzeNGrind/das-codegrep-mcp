# agenix key declarations for das-codegrep-mcp secrets
# ──────────────────────────────────────────────────────────────────────────────
# HOW TO GET YOUR HOST KEY:
#   ssh-keyscan -t ed25519 localhost 2>/dev/null | awk '{print $3}'
# Or from /etc/ssh/:
#   cat /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $1, $2}'
#
# Add your host public key below, then encrypt:
#   cd ~/flake && agenix -e secrets/github-pat.age
#   # Paste raw PAT (single line, no KEY= prefix): ghp_xxxxxxxxxxxxxxxx
# ──────────────────────────────────────────────────────────────────────────────
let
  # ── Host SSH ed25519 public keys ──────────────────────────────────────────
  # Replace these placeholders with real keys from your host(s).
  # Format: "ssh-ed25519 AAAA<base64> [optional-comment]"

  # Your NixOS-WSL machine (pc-25 or whatever hostname you use)
  # Get with: ssh-keyscan -t ed25519 localhost 2>/dev/null
  pc-25 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAPASTE_YOUR_HOST_KEY_HERE";

  # Optional: add more hosts (Oracle Cloud instance, etc.)
  # oracle-arm = "ssh-ed25519 AAAA...";

  # ── All recipients for each secret ────────────────────────────────────────
  allHosts = [ pc-25 ];
in
{
  # GitHub Personal Access Token for das-codegrep-mcp GitHub search features.
  # Scopes needed: repo (read), read:user
  # Create at: https://github.com/settings/tokens?type=beta
  "github-pat.age".publicKeys = allHosts;
}
