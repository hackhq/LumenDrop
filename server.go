package main

import (
	"io/fs"
	"mime"
	"net/http"
)

// csp keeps every script, style, worker and fetch on our own origin.
// 'wasm-unsafe-eval' is the only relaxation, needed to compile the cimbar WASM.
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

func init() {
	// Host mime.types files can override Go's built-in table; pin the one that matters.
	_ = mime.AddExtensionType(".wasm", "application/wasm")
}

// newHandler serves site as static files, plus a service worker generated from its contents.
func newHandler(site fs.FS) (http.Handler, error) {
	sw, err := buildServiceWorker(site)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(sw)
	})
	mux.Handle("/", http.FileServerFS(site))
	return withSecurityHeaders(mux), nil
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
