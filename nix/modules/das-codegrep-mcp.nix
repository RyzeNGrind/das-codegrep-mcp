# NixOS module — das-codegrep-mcp with agenix secret injection
# ─────────────────────────────────────────────────────────────────────────────
# Prerequisites in your flake.nix:
#   inputs.agenix.url = "github:ryantm/agenix";
#   imports = [ inputs.agenix.nixosModules.default ];
#
# Encrypted secret file:
#   secrets/github-pat.age   — encrypt with:
#     agenix -e secrets/github-pat.age
#   (contains a single line: ghp_xxxxxxxxxxxxxxxxxxxx)
#
# secrets.nix (in your secrets/ dir):
#   { "github-pat.age".publicKeys = [ "ssh-ed25519 AAAA... host-key" ]; }
# ─────────────────────────────────────────────────────────────────────────────
{ config, lib, pkgs, ... }:

let
  cfg = config.services.das-codegrep-mcp;
in
{
  options.services.das-codegrep-mcp = {
    enable = lib.mkEnableOption "das-codegrep-mcp local-first MCP server";

    user = lib.mkOption {
      type    = lib.types.str;
      default = "ryzengrind";
      description = "User to run the MCP server as.";
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
      description = "GitHub username for starred-repo cache.";
    };

    # Path to the agenix-decrypted secret file at runtime.
    # Default matches ryantm/agenix convention: /run/agenix/<name>
    githubPatSecretPath = lib.mkOption {
      type    = lib.types.str;
      default = "/run/agenix/github-pat";
      description = "Absolute path to the decrypted GitHub PAT file (agenix runtime path).";
    };
  };

  config = lib.mkIf cfg.enable {
    # ── agenix secret declaration ───────────────────────────────────────────
    age.secrets.github-pat = {
      # Path to the encrypted .age file, relative to your flake root.
      # Adjust if your secrets directory is named differently.
      file  = ../../../secrets/github-pat.age;
      owner = cfg.user;
      group = "users";
      mode  = "0400"; # owner-read only
    };

    # ── Environment variables injected into the login shell ─────────────────
    # These are set via PAM environment so every terminal/IDE session picks
    # them up without sourcing .envrc manually.
    environment.sessionVariables = {
      DAS_GH_USER    = cfg.ghUser;
      DAS_WORKSPACE  = cfg.workspace;
      DAS_INDEX_DIR  = cfg.indexDir;
      DAS_ZOEKT_URL  = "http://127.0.0.1:${toString cfg.zoektPort}";
      ZOEKT_PORT     = toString cfg.zoektPort;
      # DAS_GH_TOKEN is NOT set here as a literal — it is read from the
      # agenix secret file at runtime in .envrc (Option A) or via the
      # systemd service EnvironmentFile below.
    };

    # ── systemd user service (optional — runs MCP server as a daemon) ───────
    # Remove this block if you prefer to launch manually / via VSCodium.
    systemd.user.services.das-codegrep-mcp = {
      description = "das-codegrep-mcp local-first MCP server";
      wantedBy    = [ "default.target" ];
      after       = [ "network.target" ];

      serviceConfig = {
        Type             = "simple";
        ExecStart        = "/home/${cfg.user}/Workspaces/das-codegrep-mcp/bin/start";
        Restart          = "on-failure";
        RestartSec       = "5s";

        # Inject secret via EnvironmentFile — agenix writes a plain-text file
        # at /run/agenix/github-pat containing the raw PAT value.
        # We wrap it as an env file: KEY=value format.
        EnvironmentFile  = "-${cfg.githubPatSecretPath}";
        # The "-" prefix means "don't fail if file missing" (graceful degradation).
        # The file must contain exactly one line: DAS_GH_TOKEN=ghp_xxx
        # Generate it with: echo "DAS_GH_TOKEN=$(cat /run/agenix/github-pat)" > /run/agenix/github-pat-env
        # Or use the wrapper script below.

        Environment = [
          "DAS_GH_USER=${cfg.ghUser}"
          "DAS_WORKSPACE=${cfg.workspace}"
          "DAS_INDEX_DIR=${cfg.indexDir}"
          "ZOEKT_PORT=${toString cfg.zoektPort}"
        ];

        StandardOutput = "journal";
        StandardError  = "journal";
        SyslogIdentifier = "das-codegrep-mcp";
      };
    };

    # ── direnv auto-allow for workspace ─────────────────────────────────────
    # If you use home-manager + direnv, this auto-allows the workspace .envrc
    # so the secret path resolves on first cd.
    # programs.direnv.enableNixDirenvIntegration = true; # in home-manager
  };
}
