# Lumen Drop

Send a file from one device to another using only a screen and a camera: no internet,
Bluetooth, or cables. The sending screen plays the file as moving color barcodes; the
receiving camera reads them and rebuilds the file.

It is a small web app (installable, works offline) with two kinds of code:

- **Color code** ([libcimbar](https://github.com/sz3/libcimbar) by sz3): the fast default.
- **QR code** ([txqr](https://github.com/divan/txqr) by divan): plain black-and-white QR codes
  that almost any camera reads, for files up to 1 MB. Several times slower.

The receiver works out which kind the sender is playing by itself.

## How it works

- **Send:** the file is compressed (zstd), split with fountain codes, and drawn as an
  animation of [cimbar](https://github.com/sz3/libcimbar) codes with WebGL.
- **Receive:** camera frames go to a few Web Workers running the libcimbar decoder; the
  fountain decoder reassembles the file on the device, and you save or share it.
- **The server only delivers the app.** Files never touch it. After the first visit, a
  service worker serves everything from the device, so it works with no network at all.

Speed is roughly 100 KB/s (libcimbar's figure; not yet measured with this app). So far, full
send-to-receive runs are tested with small files (20 KB); the sender has encoded files up to 20 MB.
In desktop Chromium the encoder runs out of memory somewhere around 30 MB, and the page says so
instead of failing silently. Limits on phones are not yet measured.

## Use it

1. Open the app once on both devices while online (or install it to the home screen).
2. On the sending device, choose **Send a file** and pick the file. The screen starts flashing codes.
3. On the receiving device, choose **Receive a file**, tap **Start camera**, and point it at the
   sending screen with the whole code in view.
4. When it reaches 100%, tap **Save file** (or **Share** on phones).

Choose **Color code** or **QR code** before picking the file. While the code plays, the bar at
the top has two more controls. Each is remembered on that device:

- **Resolution (Low / Medium / High):** lower resolution draws bigger symbols, which weaker
  cameras read more easily, but each frame carries less, so the transfer takes more frames
  (Low carries about 44% of High, Medium about 70%). The receiver follows a change by itself.
  In QR mode the same buttons choose 200, 400 or 600 bytes per QR code.
- **Speed (5 / 8 / 12 / 15 fps):** slower keeps each frame on screen longer.

The code also moves a few pixels every frame. That is libcimbar's design, not a glitch: it
lets the receiver throw away blurred frames early
([explanation](https://github.com/sz3/libcimbar/issues/127)).

### If the receiver stays at 0%

The usual cause is the camera blending two consecutive codes into one blurry frame (a slow
shutter in a dim room, or a slow laptop LCD). Try, in this order:

1. Turn on the room lights and lower the sending screen's brightness a little.
2. Choose **Low** resolution and **8** (or **5**) fps on the sender.
3. Open the receiver as `recv.html?camfps=30`, which caps the camera's shutter time.

`recv.html#debug` shows what the camera delivers and what the decoder reports, with a
**Save frame** button for a full-resolution still. `#debug-bitmap` forces the fallback
capture path for comparison.

## Run locally

Requires Go 1.22+.

```sh
go run .            # http://127.0.0.1:8080
go run . -addr 127.0.0.1:9000
```

Browsers allow the camera on `localhost`/`127.0.0.1` without HTTPS. To test on a phone,
you need HTTPS (see deploy below).

## Build and deploy

The binary embeds the whole site (`web/`), so deploying is copying one file.

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o lumendrop .
```

Run it behind [Caddy](https://caddyserver.com/), which gets HTTPS certificates
automatically (phones only allow the camera over HTTPS). See [`Caddyfile`](Caddyfile):

```caddyfile
drop.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
```

A systemd unit that runs it as an unprivileged, sandboxed user:

```ini
# /etc/systemd/system/lumendrop.service
[Unit]
Description=Lumen Drop
After=network.target

[Service]
ExecStart=/usr/local/bin/lumendrop -addr 127.0.0.1:8080
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The server listens on `127.0.0.1` by default so it is reachable only through the proxy.
Each start generates `sw.js` from a hash of the embedded files. After a deploy, an open
page reloads itself once the new version has installed, except while a transfer is on screen.

## Security and privacy

- **The codes are not encrypted.** Anyone who can see or film the sending screen can
  recover the file. Send sensitive files only where no one else can watch the screen.
- Received files are untrusted. The app never opens them; it only offers Save or Share.
- Strict Content Security Policy, no third-party requests, no analytics.
- The send screen flashes colors: not suitable for people with photosensitive epilepsy.

## Tests

```sh
go test ./...                                     # server, headers, service worker
(cd qr && go test ./...)                          # QR codec: QR round trips, fountain coverage, bad frames
node --test --test-concurrency=1 test/browser/    # pages in headless Chromium (Node 22+, chromium on PATH)
```

The browser tests record the send page's barcode, feed it to the receive page as a fake
camera, and check the saved file byte for byte. They also check offline use and error states.

## Credits

- [libcimbar](https://github.com/sz3/libcimbar) by sz3: the encoder and decoder (MPL-2.0).
  Its WASM build includes OpenCV, zstd, wirehair, libcorrect and others; their licenses are in
  [`web/vendor/cimbar/third_party/`](web/vendor/cimbar/third_party/).
- [txqr](https://github.com/divan/txqr) by divan: the QR code protocol (MIT), built to
  WebAssembly with go-qrcode, gozxing and gofountain; see [`web/vendor/qr/`](web/vendor/qr/).
- [Unbounded](https://github.com/googlefonts/unbounded) typeface (SIL OFL 1.1).

## License

Lumen Drop's own code is [MIT](LICENSE). Bundled files keep their licenses:
`web/vendor/cimbar/` is MPL-2.0 (unmodified libcimbar release files; see its
[README](web/vendor/cimbar/README.md) for the source and how to upgrade), `web/vendor/qr/` lists
the licenses of what `qr.wasm` contains, and `web/fonts/` is OFL-1.1.
