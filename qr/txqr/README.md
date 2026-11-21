# Vendored txqr

`encode.go`, `decode.go`, `fountain.go`, `doc.go` and `LICENSE` are copied unmodified from
[divan/txqr](https://github.com/divan/txqr) at commit `d92929c20d825f735dc9b9184176483e6ca419cc` (MIT).
Only the protocol package is vendored: upstream's go.mod pins tools we don't use, one of which
(`github.com/pyk/byten`) no longer exists, so the module can't be fetched as a dependency.
Check with `sha256sum -c SHA256SUMS`.
