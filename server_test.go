package main

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const wantCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

func testSite() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>home</title>")},
		"send.html":     {Data: []byte("<!doctype html><title>send</title>")},
		"vendor/x.wasm": {Data: []byte("\x00asm\x01\x00\x00\x00")},
	}
}

func mustHandler(t *testing.T, site fs.FS) http.Handler {
	t.Helper()
	h, err := newHandler(site)
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}
	return h
}

func get(h http.Handler, path string) (*http.Response, string) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestSecurityHeaders(t *testing.T) {
	h := mustHandler(t, testSite())
	for _, path := range []string{"/", "/send.html", "/sw.js", "/nope"} {
		res, _ := get(h, path)
		if got := res.Header.Get("Content-Security-Policy"); got != wantCSP {
			t.Errorf("%s CSP = %q, want %q", path, got, wantCSP)
		}
		if got := res.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s X-Content-Type-Options = %q", path, got)
		}
		if got := res.Header.Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("%s Referrer-Policy = %q", path, got)
		}
	}
}

func TestWasmMime(t *testing.T) {
	res, _ := get(mustHandler(t, testSite()), "/vendor/x.wasm")
	if res.StatusCode != 200 {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if got := res.Header.Get("Content-Type"); got != "application/wasm" {
		t.Errorf("Content-Type = %q, want application/wasm", got)
	}
}

func TestServiceWorker(t *testing.T) {
	res, body := get(mustHandler(t, testSite()), "/sw.js")
	if res.StatusCode != 200 {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", got)
	}
	if got := res.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Errorf("Content-Type = %q, want text/javascript", got)
	}
	for _, want := range []string{`"./"`, `"./send.html"`, `"./vendor/x.wasm"`} {
		if !strings.Contains(body, want) {
			t.Errorf("sw.js missing %s", want)
		}
	}
	for _, bad := range []string{`"./index.html"`, `"./sw.js"`} {
		if strings.Contains(body, bad) {
			t.Errorf("sw.js must not precache %s", bad)
		}
	}
}

func TestServiceWorkerVersionChangesWithContent(t *testing.T) {
	a, err := buildServiceWorker(testSite())
	if err != nil {
		t.Fatal(err)
	}
	changed := testSite()
	changed["send.html"] = &fstest.MapFile{Data: []byte("<!doctype html><title>send v2</title>")}
	b, err := buildServiceWorker(changed)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) == string(b) {
		t.Error("sw.js identical after a content change; clients would never update")
	}
	again, _ := buildServiceWorker(testSite())
	if string(a) != string(again) {
		t.Error("sw.js not deterministic for identical content")
	}
}

func TestNotFound(t *testing.T) {
	res, _ := get(mustHandler(t, testSite()), "/nope")
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", res.StatusCode)
	}
}

func TestDefaultAddrIsLoopback(t *testing.T) {
	if defaultAddr != "127.0.0.1:8080" {
		t.Errorf("defaultAddr = %q; must not listen on all interfaces by default", defaultAddr)
	}
}
