# nix/module.nix — NixOS system-wide service module
{ config, lib, pkgs, ... }:
let
  cfg   = config.services.dasCodegrepMcp;
  zoekt = pkgs.zoekt;
in {
  options.services.dasCodegrepMcp = {
    enable = lib.mkEnableOption "das-codegrep-mcp local Zoekt MCP server";

    indexDirs = lib.mkOption {
      type    = lib.types.listOf lib.types.str;
      default = [ "/home/nixos/code" ];
      description = "Directories to index with Zoekt.";
    };

    indexPath = lib.mkOption {
      type    = lib.types.str;
      default = "/var/lib/das-codegrep-mcp/index";
    };

    port = lib.mkOption {
      type    = lib.types.port;
      default = 6070;
      description = "Zoekt web/REST server port (localhost only).";
    };

    reindexInterval = lib.mkOption {
      type    = lib.types.str;
      default = "15min";
      description = "systemd timer interval for reindexing.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules = [
      "d ${cfg.indexPath} 0750 root root -"
    ];

    systemd.services.das-codegrep-index = {
      description = "das-codegrep-mcp: Zoekt indexer";
      serviceConfig = {
        Type            = "oneshot";
        ExecStart       = let
          dirs = lib.concatStringsSep " " cfg.indexDirs;
        in "${zoekt}/bin/zoekt-index -index ${cfg.indexPath} ${dirs}";
        PrivateTmp      = true;
        ProtectSystem   = "strict";
        ReadWritePaths  = [ cfg.indexPath ];
        NoNewPrivileges = true;
      };
    };

    systemd.timers.das-codegrep-index = {
      description = "das-codegrep-mcp: periodic reindex";
      wantedBy    = [ "timers.target" ];
      timerConfig = {
        OnBootSec       = "2min";
        OnUnitActiveSec = cfg.reindexInterval;
        Persistent      = true;
      };
    };

    systemd.services.das-codegrep-web = {
      description = "das-codegrep-mcp: Zoekt web/REST server";
      after       = [ "das-codegrep-index.service" ];
      wantedBy    = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart       = "${zoekt}/bin/zoekt-webserver -index ${cfg.indexPath} -listen 127.0.0.1:${toString cfg.port}";
        Restart         = "on-failure";
        PrivateTmp      = true;
        ProtectSystem   = "strict";
        ReadOnlyPaths   = [ cfg.indexPath ];
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        LockPersonality       = true;
        RestrictRealtime      = true;
        RestrictNamespaces    = true;
        SystemCallFilter      = [ "@system-service" ];
      };
    };
  };
}
