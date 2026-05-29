# agenix key declarations for das-codegrep-mcp secrets
# ──────────────────────────────────────────────────────────────────────────────
# HOW TO GET YOUR HOST KEY (key material only, no comment):
#   cat /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $1, $2}'
# Or:
#   ssh-keyscan -t ed25519 localhost 2>/dev/null | awk '{print $2, $3}'
#
# Add your host public key below (no trailing "user@host" comment — agenix
# only needs the algorithm + base64 blob), then encrypt:
#   cd ~/Workspaces/das-codegrep-mcp
#   agenix -e secrets/github-pat.age
#   # Paste raw PAT (single line, no KEY= prefix): ghp_xxxxxxxxxxxxxxxx
# ──────────────────────────────────────────────────────────────────────────────
let
  # ── Host SSH ed25519 public keys ──────────────────────────────────────────
  # Key material only — intentionally no "user@host" trailing comment.
  # gitleaks will flag lines that look like credential assignments with
  # recognisable host suffixes, so we keep only: "ssh-ed25519 AAAA<base64>"

  # NixOS-WSL machine (pc-25)
  # Obtain with: cat /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $1, $2}'
  pc-25 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfV0pP4xYnWvCr+TS3hiv33hTadVI+Hch58LH5o48LL";

  # ── User SSH keys (optional – add your personal ed25519 pubkey here) ──────
  # ryzengrind = "ssh-ed25519 AAAA<your-user-key-base64>";

  # ── Optional: additional hosts (Oracle Cloud, etc.) ───────────────────────
  # oracle-arm = "ssh-ed25519 AAAA...";

  # ── All recipients for each secret ────────────────────────────────────────
  allHosts = [ pc-25 ];
in
{
  # GitHub Personal Access Token for das-codegrep-mcp GitHub search features.
  # Scopes needed: repo (read), read:user
  # Fine-grained PAT: https://github.com/settings/tokens?type=beta
  # Classic PAT:      https://github.com/settings/tokens
  "github-pat.age".publicKeys = allHosts;
}
