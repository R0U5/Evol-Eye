// EVOL Eye — portable desktop wrapper (Windows .exe).
//
// Embeds the production web bundle (a copy of repo dist/ under app/), serves
// it over loopback HTTP, and renders it in a WebView2 window (the Microsoft
// Edge rendering engine). No Node, no browser install, no admin rights.
//
// Package main — this is the shipped artifact (Evol-Eye-Installer.exe).
// installer/build.mjs refreshes installer/app/ from dist/ before every build:
// //go:embed patterns are relative to this package directory and cannot reach
// ../dist, so the bundle is staged next to the source on purpose.

package main

import (
	"embed"
	"io/fs"
	"net"
	"net/http"
	"os"
	"time"
)
import webview "github.com/webview/webview_go"

// The embedded production bundle (refreshed from dist/ by installer/build.mjs).
//go:embed app/*
var app embed.FS

const (
	AppName    = "EVOL Eye"
	AppVersion = "0.1.0"
)

type EvolEyeInfo struct {
	App      string
	Version  string
	Platform string
}

// securityHeader wraps any handler with the security headers the app
// expects: a locked-down CSP (assets only from the loopback origin, plus
// outbound https for the live data feeds WebView2 reaches directly),
// MIME-sniffing protection, no referrer leakage, and clickjacking defense.
func securityHeader(h http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hdr := rw.Header()
		hdr.Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' https:; img-src 'self' https: data:; script-src 'self'; style-src 'self' 'unsafe-inline';")
		hdr.Set("X-Content-Type-Options", "nosniff")
		hdr.Set("Referrer-Policy", "no-referrer")
		hdr.Set("X-Frame-Options", "DENY")
		h.ServeHTTP(rw, r)
	})
}

// serveApp binds a loopback listener on an OS-chosen port and serves the
// embedded bundle on it. It returns the base URL, or an error.
func serveApp() (url string, err error) {
	webRoot, err := fs.Sub(app, "app")
	if err != nil {
		return "", err
	}

	mux := http.NewServeMux()
	// M-2: serve the embedded bundle with CSP + hardening headers.
	mux.Handle("/", securityHeader(http.FileServer(http.FS(webRoot))))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	// The listener bound to port 0, so the address string carries the
	// OS-assigned port — hand that straight back to the caller.
	url = "http://" + ln.Addr().String() + "/"

	server := &http.Server{
		Addr:         "127.0.0.1:0",
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  5 * time.Minute,
	}
	go func() {
		if err := server.Serve(ln); err != nil {
			// Only reachable on shutdown races; the window is already
			// closing, so don't take the process down noisily.
			print("evol-eye: server stopped: " + err.Error())
		}
	}()

	return url, nil
}

func main() {
	url, err := serveApp()
	if err != nil {
		print("evol-eye: failed to start local server: " + err.Error())
		os.Exit(1)
	}

	// EVOL_EYE_DEBUG=1 enables the WebView2 developer tools (QA/testing).
	debug := os.Getenv("EVOL_EYE_DEBUG") != ""

	w := webview.New(debug)
	defer w.Destroy()

	// Tiny IPC bridge so embedded content can identify its host wrapper.
	// JS side: await window.evolEyeInfo() (only present inside the exe).
	w.Bind("evolEyeInfo", func() EvolEyeInfo {
		return EvolEyeInfo{
			App:      AppName,
			Version:  AppVersion,
			Platform: "webview2-exe",
		}
	})

	w.SetTitle(AppName)
	w.SetSize(1280, 800, webview.HintNone)
	w.Navigate(url)
	w.Run()
	// Window closed — fall off the end of main and let the process exit.
	// deferred w.Destroy() runs first; the loopback server goes down with
	// the process, so nothing is left listening on the ephemeral port.
}