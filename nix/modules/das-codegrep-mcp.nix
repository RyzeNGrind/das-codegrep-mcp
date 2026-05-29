# NixOS module — das-codegrep-mcp with agenix GH PAT injection
# ─────────────────────────────────────────────────────────────────────────────
# Prerequisites in your host flake.nix:
#
#   inputs.agenix.url = "github:ryantm/agenix";
#   inputs.das-codegrep-mcp.url = "github:RyzeNGrind/das-codegrep-mcp";
#
# In nixosConfigurations.pc.modules:
#   inputs.agenix.nixosModules.default
#   inputs.das-codegrep-mcp.nixosModules.das-codegrep-mcp
#
# Encrypted secret (create once):
#   cd ~/Workspaces/das-codegrep-mcp
#   RULES=$(pwd)/secrets/secrets.nix agenix -e github-pat.age -i ~/.ssh/id_ed25519
#   # paste raw PAT: ghp_xxxxxxxxxxxxxxxx  (single line, no KEY= prefix)
#   mv github-pat.age secrets/github-pat.age
#
# secrets/secrets.nix must list your host's ed25519 public key:
#   { "github-pat.age".publicKeys = [ "ssh-ed25519 AAAA..." ]; }
# ─────────────────────────────────────────────────────────────────────────────
{ config, lib, pkgs, ... }:

let
  cfg = config.services.das-codegrep-mcp;

  # Script that converts the raw agenix secret (plain PAT value) into
  # a KEY=value env file that systemd EnvironmentFile= can consume.
  # Written to /run/das-codegrep-mcp/github-pat.env (tmpfs, no disk trace).
  patEnvGen = pkgs.writeShellScript "das-codegrep-pat-env-gen" ''
    set -euo pipefail
    SECRET_FILE="/run/agenix/github-pat"
    ENV_FILE="/run/das-codegrep-mcp/github-pat.env"

    install -d -m 0700 -o ${cfg.user} /run/das-codegrep-mcp

    if [ -r "$SECRET_FILE" ]; then
      PAT="$(< "$SECRET_FILE")"
      printf 'DAS_GH_TOKEN=%s\n' "$PAT" > "$ENV_FILE"
      chmod 0400 "$ENV_FILE"
      chown ${cfg.user} "$ENV_FILE"
      echo "[das-codegrep] PAT env file written to $ENV_FILE"
    else
      echo "[das-codegrep] WARN: $SECRET_FILE not readable — GitHub search disabled"
      printf 'DAS_GH_TOKEN=\n' > "$ENV_FILE"
    fi
  '';
in
{
  options.services.das-codegrep-mcp = {
    enable = lib.mkEnableOption "das-codegrep-mcp local-first MCP server";

    user = lib.mkOption {
      type    = lib.types.str;
      default = "ryzengrind";
      description = "Linux user to run the MCP server as.";
    };

    workspace = lib.mkOption {
      type    = lib.types.str;
      default = "/home/ryzengrind/Workspaces";
      description = "Root workspace directory exposed to the MCP server.";
    };

    indexDir = lib.mkOption {
      type    = lib.types.str;
      default = "/home/ryzengrind/.local/share/das-codegrep-mcp/index";
      description = "Zoekt shard index directory.";
    };

    zoektPort = lib.mkOption {
      type    = lib.types.port;
      default = 6070;
      description = "Port zoekt-webserver listens on.";
    };

    ghUser = lib.mkOption {
      type    = lib.types.str;
      default = "RyzeNGrind";
      description = "GitHub username for starred-repo cache and API calls.";
    };

    # Path to the .age file, relative to the flake root.
    # Override if your secrets dir is named differently.
    githubPatAgeFile = lib.mkOption {
      type    = lib.types.path;
      default = ../../../secrets/github-pat.age;
      description = "Path to the age-encrypted GitHub PAT file.";
    };

    enableSystemdService = lib.mkOption {
      type    = lib.types.bool;
      default = false;
      description = "Whether to run das-codegrep-mcp as a systemd user service.";
    };

    mcpBin = lib.mkOption {
      type    = lib.types.str;
      default = "/home/ryzengrind/Workspaces/das-codegrep-mcp/bin/start";
      description = "Absolute path to the MCP server start script.";
    };
  };

  config = lib.mkIf cfg.enable {
    # ── 1. agenix secret declaration ────────────────────────────────────────
    # agenix decrypts this at boot to /run/agenix/github-pat (tmpfs).
    age.secrets.github-pat = {
      file  = cfg.githubPatAgeFile;
      owner = cfg.user;
      group = "users";
      mode  = "0400"; # owner-read only — no world/group read
    };

    # ── 2. Session-level env vars (no secret here) ───────────────────────────
    # Available in every interactive shell, VSCodium, terminal, etc.
    # DAS_GH_TOKEN is NOT set here — it comes from agenix at shell startup.
    environment.sessionVariables = {
      DAS_GH_USER   = cfg.ghUser;
      DAS_WORKSPACE = cfg.workspace;
      DAS_INDEX_DIR = cfg.indexDir;
      DAS_ZOEKT_URL = "http://127.0.0.1:${toString cfg.zoektPort}";
      ZOEKT_PORT    = toString cfg.zoektPort;
    };

    # ── 3. PAM snippet: load PAT from agenix into interactive sessions ───────
    # Adds a single export to /etc/profile.d so all shells pick up the token.
    environment.etc."profile.d/das-codegrep-mcp-pat.sh" = {
      text = ''
        # das-codegrep-mcp: load GH PAT from agenix secret into shell session
        if [ -r /run/agenix/github-pat ]; then
          export DAS_GH_TOKEN="$(< /run/agenix/github-pat)"
        fi
      '';
      mode = "0444";
    };

    # ── 4. systemd user service (opt-in) ────────────────────────────────────
    systemd.user.services = lib.mkIf cfg.enableSystemdService {
      das-codegrep-mcp = {
        description = "das-codegrep-mcp local-first MCP server";
        wantedBy    = [ "default.target" ];
        after       = [ "network.target" ];

        serviceConfig = {
          Type      = "simple";
          Restart   = "on-failure";
          RestartSec = "5s";

          # Step 1: generate KEY=value env file from raw agenix secret
          ExecStartPre = [
            "+${patEnvGen}"   # '+' = run as root so it can read /run/agenix
          ];

          # Step 2: start server with that env file
          ExecStart = cfg.mcpBin;

          # EnvironmentFile with KEY=value format — generated by patEnvGen above
          EnvironmentFile = "-/run/das-codegrep-mcp/github-pat.env";

          Environment = [
            "DAS_GH_USER=${cfg.ghUser}"
            "DAS_WORKSPACE=${cfg.workspace}"
            "DAS_INDEX_DIR=${cfg.indexDir}"
            "ZOEKT_PORT=${toString cfg.zoektPort}"
            "DAS_ZOEKT_URL=http://127.0.0.1:${toString cfg.zoektPort}"
          ];

          StandardOutput    = "journal";
          StandardError     = "journal";
          SyslogIdentifier  = "das-codegrep-mcp";
        };
      };
    };
  };
}
