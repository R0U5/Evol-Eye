// EVOL Eye — embedded-bundle selftest (headless).
//
// Deliberately does NOT import the webview binding: it exercises the exact
// embed → fs.Sub → http.FileServer → loopback-socket pipeline the exe uses,
// but with zero GUI/CGo dependencies, so it builds and runs on plain Linux
// CI runners as well as on Windows.
//
// Build:  go build -o selftest selftest   (inside the installer module)
// Run:    ./selftest      → exit 0 on PASS, 1 on failure.
//
// The app bundle must be staged at selftest/app/ before building (the same
// installer/build.mjs step that stages installer/app/ does this one).

package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"time"
)

// Staged copy of repo dist/ (refreshed by installer/build.mjs).
//go:embed app/*
var app embed.FS

// Walk accumulator (package scope: closures can't capture return slots).
var (
	fileList  = []string{}
	totalSize uint
)

type ProbeResult struct {
	Url         string
	Status      int
	Bytes       uint
	ContentType string
}

func main() {
	problems := 0
	fmt.Println("evol-eye selftest: begin")

	// 1. Inventory the embedded bundle.
	if err := inventory(); err != nil {
		fmt.Println("evol-eye selftest: inventory failed: " + err.Error())
		os.Exit(1)
	}
	fmt.Println(fmt.Sprintf("evol-eye selftest: embedded files=%d bytes=%d", len(fileList), totalSize))

	if len(fileList) == 0 {
		fmt.Println("evol-eye selftest: FAIL — empty embedded bundle")
		os.Exit(1)
	}
	for _, req := range []string{
		"app/index.html",
		"app/cesium/Cesium.js",
		"app/cesium/Workers/",
		"app/models/",
		"app/assets/",
	} {
		if !hasPrefixAny(fileList, req) {
			fmt.Println("evol-eye selftest: FAIL — missing " + req)
			problems++
		}
	}

	// 2. Start the loopback server.
	url, err := startServer()
	if err != nil {
		fmt.Println("evol-eye selftest: FAIL — " + err.Error())
		os.Exit(1)
	}
	fmt.Println("evol-eye selftest: server on " + url)

	// 3. Derive probe targets from the bundle itself so we can never
	//    "pass" by testing an empty app: index.html's own references plus
	//    a sample of each asset class.
	targets := probeTargets()

	// 4. Wait for the server, then probe.
	if !waitReady(url, 5 * time.Second) {
		fmt.Println("evol-eye selftest: FAIL — server did not answer on " + url)
		os.Exit(1)
	}
	for _, t := range targets {
		res := fetchProbe(url + t)
		fmt.Println(fmt.Sprintf("evol-eye selftest: %s -> %d %s (%d bytes)",
			t, res.Status, res.ContentType, res.Bytes))
		if res.Status != 200 || res.Bytes == 0 {
			problems++
		}
	}

	// 5. Strict content checks for the entry points.
	html := fetchProbe(url + "index.html")
	htmlText := string(fetchBody(url + "index.html"))
	if html.Status != 200 || !contains(htmlText, "EVOL EYE") {
		fmt.Println("evol-eye selftest: FAIL — index.html does not contain the app title")
		problems++
	}
	js := fetchProbe(url + firstAssetExt("app/assets/", ".js"))
	if js.Status == 200 && !contains(js.ContentType, "javascript") {
		fmt.Println("evol-eye selftest: FAIL — JS served with non-JS content type: " + js.ContentType)
		problems++
	}

	// 6. Verdict.
	if problems == 0 {
		fmt.Println("evol-eye selftest: PASS")
		os.Exit(0)
	}
	fmt.Println(fmt.Sprintf("evol-eye selftest: FAIL — %d problem(s)", problems))
	os.Exit(1)
}

// ===== helpers =====

func inventory() error {
	fsys, err := fs.Sub(app, "app")
	if err != nil {
		return err
	}
	walkErr := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, wErr error) error {
		if d.IsDir() {
			return nil
		}
		fileList = append(fileList, "app/" + path)
		if info, ierr := d.Info(); ierr == nil {
			totalSize += uint(info.Size())
		}
		return nil
	})
	return walkErr
}

func startServer() (url string, err error) {
	webRoot, err := fs.Sub(app, "app")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	_, port, perr := net.SplitHostPort(ln.Addr().String())
	if perr != nil {
		return "", perr
	}

	server := &http.Server{
		Addr:    "127.0.0.1:0",
		Handler: mux,
	}
	go func() {
		server.Serve(ln)
	}()

	return "http://127.0.0.1:" + port + "/", nil
}

func waitReady(url string, budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if res, gerr := http.Get(url); gerr == nil {
			defer res.Body.Close()
			return res.StatusCode == 200
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func fetchProbe(url string) ProbeResult {
	res, gerr := http.Get(url)
	if gerr != nil {
		return ProbeResult{Url: url, Status: 0, Bytes: 0, ContentType: gerr.Error()}
	}
	defer res.Body.Close()
	data, rerr := io.ReadAll(res.Body)
	if rerr != nil {
		return ProbeResult{Url: url, Status: res.StatusCode, Bytes: 0, ContentType: "read error"}
	}
	return ProbeResult{
		Url:         url,
		Status:      res.StatusCode,
		Bytes:       uint(len(data)),
		ContentType: res.Header.Get("Content-Type"),
	}
}

func fetchBody(url string) []byte {
	res, gerr := http.Get(url)
	if gerr != nil {
		return nil
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return data
}

// probeTargets extracts every local asset URL referenced by index.html, then
// appends a sample of each asset class so a broken class is always probed
// even when index.html stops referencing it.
func probeTargets() []string {
	out := []string{"/"}
	if html := fsysRead(app, "app/index.html"); html != nil {
		for _, m := range findRefs(string(html)) {
			out = append(out, m)
		}
	}
	out = append(out, firstAsset("app/cesium/"))
	out = append(out, firstAsset("app/cesium/Workers/"))
	out = append(out, firstAsset("app/cesium/ThirdParty/"))
	out = append(out, firstAsset("app/models/"))
	out = append(out, firstAsset("app/assets/"))
	return dedupe(out)
}

func fsysRead(fsys fs.FS, name string) []byte {
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil
	}
	return data
}

func firstAsset(prefix string) string {
	return firstAssetExt(prefix, "")
}

func firstAssetExt(prefix, ext string) string {
	for _, f := range fileList {
		if startswith(f, prefix) && (ext == "" || endswith(f, ext)) {
			return "/" + f[len("app/"):]
		}
	}
	return "/"
}

func endswith(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}

func hasPrefixAny(list []string, prefix string) bool {
	for _, f := range list {
		if startswith(f, prefix) {
			return true
		}
	}
	return false
}

func dedupe(inp []string) []string {
	out := []string{}
	for _, v := range inp {
		seen := false
		for _, o := range out {
			if o == v {
				seen = true
				break
			}
		}
		if !seen {
			out = append(out, v)
		}
	}
	return out
}

func startswith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	if len(haystack) < len(needle) {
		return false
	}
	for i := 0; i <= len(haystack) - len(needle); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

// findRefs returns quoted "/..." references found in the built HTML.
func findRefs(text string) []string {
	out := []string{}
	for i := 0; i + 1 < len(text); i++ {
		// Look for a quoted path: a double quote directly before a slash.
		if text[i] == '"' && text[i+1] == '/' {
			j := i + 2
			for j < len(text) && text[j] != '"' {
				j++
			}
			ref := text[i+1:j]
			if len(ref) > 1 && !contains(ref, "http") {
				out = append(out, ref)
			}
			i = j
		}
	}
	return out
}