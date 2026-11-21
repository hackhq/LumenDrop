// Command lumendrop serves the LumenDrop web app from a single binary.
// Put it behind a TLS-terminating proxy such as Caddy: browsers only allow
// camera access over HTTPS (or on localhost).
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"time"
)

//go:embed web
var embedded embed.FS

const defaultAddr = "127.0.0.1:8080"

func main() {
	addr := flag.String("addr", defaultAddr, "listen address; keep it on loopback when behind a proxy")
	flag.Parse()

	site, err := fs.Sub(embedded, "web")
	if err != nil {
		log.Fatal(err)
	}
	handler, err := newHandler(site)
	if err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("LumenDrop listening on http://%s", *addr)
	log.Fatal(srv.ListenAndServe())
}
