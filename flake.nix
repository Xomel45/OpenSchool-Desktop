{
  description = "OpenSchool: unofficial desktop client for «Моя школа»";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # The bridge is a git submodule, so the checkout has to be fetched with submodules:
  #   nix run 'github:Xomel45/OpenSchool-Desktop?submodules=1'
  #   nix build '.?submodules=1'
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      openschool = pkgs.callPackage ./packaging/nix/package.nix { src = self; };
    in {
      packages.${system} = { default = openschool; openschool = openschool; };
      apps.${system}.default = { type = "app"; program = "${openschool}/bin/openschool_desktop"; };
      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ openschool ];
        packages = with pkgs; [ rustc cargo rust-analyzer ];
      };
    };
}
