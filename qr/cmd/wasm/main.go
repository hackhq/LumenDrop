//go:build js && wasm

// Command wasm exposes the QR codec to JavaScript as the global LumenQR.
// Build with ../../build.sh; the output lives in web/vendor/qr/.
package main

import (
	"fmt"
	"syscall/js"
	"time"

	"lumendrop/qr/codec"
)

var (
	sender   *codec.Sender
	receiver = codec.NewReceiver()
	lum      []byte // reused between scans: Go WASM memory only grows
)

// guard turns a Go panic into a JS error object instead of killing the WASM instance.
func guard(fn func(args []js.Value) any) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) (out any) {
		defer func() {
			if p := recover(); p != nil {
				out = map[string]any{"error": fmt.Sprint(p)}
			}
		}()
		return fn(args)
	})
}

func bytesFromJS(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

func bytesToJS(b []byte) js.Value {
	u := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(u, b)
	return u
}

func status(st codec.Status, extra map[string]any) map[string]any {
	m := map[string]any{
		"progress": st.Progress, "blocks": st.Blocks, "chunks": st.Chunks,
		"total": st.Total, "done": st.Done,
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func main() {
	js.Global().Set("LumenQR", map[string]any{
		"maxFileSize": codec.MaxFileSize,

		// newSender(name, Uint8Array, chunkLen) -> {frames} | {error}
		"newSender": guard(func(a []js.Value) any {
			s, err := codec.NewSender(a[0].String(), bytesFromJS(a[1]), a[2].Int())
			if err != nil {
				return map[string]any{"error": err.Error()}
			}
			sender = s
			return map[string]any{"frames": s.Len()}
		}),

		// matrix(i) -> {size, bits: Uint8Array} for frame i of the current sender
		"matrix": guard(func(a []js.Value) any {
			size, bits, err := codec.Matrix(sender.Frame(a[0].Int() % sender.Len()))
			if err != nil {
				return map[string]any{"error": err.Error()}
			}
			return map[string]any{"size": size, "bits": bytesToJS(bits)}
		}),

		// scanFeed(Uint8Array luminance, width, height) -> {found, valid, scanMs, ...status}
		"scanFeed": guard(func(a []js.Value) any {
			n := a[0].Get("length").Int()
			if cap(lum) < n {
				lum = make([]byte, n)
			}
			lum = lum[:n]
			js.CopyBytesToGo(lum, a[0])
			start := time.Now()
			text, err := codec.Scan(lum, a[1].Int(), a[2].Int())
			ms := float64(time.Since(start).Microseconds()) / 1000
			if err != nil {
				return map[string]any{"found": false, "valid": false, "scanMs": ms}
			}
			st, err := receiver.Feed(text)
			return status(st, map[string]any{"found": true, "valid": err == nil, "scanMs": ms})
		}),

		// result() -> {name, data: Uint8Array} once done, else null
		"result": guard(func(a []js.Value) any {
			name, data, ok := receiver.Result()
			if !ok {
				return nil
			}
			return map[string]any{"name": name, "data": bytesToJS(data)}
		}),

		"reset": guard(func(a []js.Value) any {
			receiver.Reset()
			return nil
		}),
	})
	select {} // keep the exported functions alive
}
