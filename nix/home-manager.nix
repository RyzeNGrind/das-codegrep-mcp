# nix/home-manager.nix — Home Manager user service module (NixOS-WSL safe)
{ config, lib, pkgs, ... }:
let
  cfg = config.services.dasCodegrepMcp;
in {
  options.services.dasCodegrepMcp = {
    enable = lib.mkEnableOption "das-codegrep-mcp user service";

    package = lib.mkOption {
      type        = lib.types.package;
      description = "das-codegrep-mcp package.";
    };

    indexDirs = lib.mkOption {
      type    = lib.types.listOf lib.types.str;
      default = [ "${config.home.homeDirectory}/code" ];
    };

    indexDir = lib.mkOption {
      type    = lib.types.str;
      default = "${config.home.homeDirectory}/.local/share/das-codegrep-mcp/index";
    };

    port = lib.mkOption {
      type    = lib.types.port;
      default = 6070;
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ pkgs.zoekt cfg.package ];

    systemd.user.services.das-codegrep-web = {
      Unit.Description    = "das-codegrep-mcp: Zoekt web server";
      Service = {
        ExecStart = "${pkgs.zoekt}/bin/zoekt-webserver -index ${cfg.indexDir} -listen 127.0.0.1:${toString cfg.port}";
        Restart   = "on-failure";
      };
      Install.WantedBy = [ "default.target" ];
    };

    systemd.user.services.das-codegrep-index = {
      Unit.Description    = "das-codegrep-mcp: Zoekt indexer";
      Service = {
        Type      = "oneshot";
        ExecStart = "${pkgs.zoekt}/bin/zoekt-index -index ${cfg.indexDir} ${lib.concatStringsSep " " cfg.indexDirs}";
      };
    };

    systemd.user.timers.das-codegrep-index = {
      Unit.Description        = "das-codegrep-mcp: periodic reindex";
      Timer = {
        OnBootSec       = "2m";
        OnUnitActiveSec = "15m";
        Persistent      = true;
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };
}
