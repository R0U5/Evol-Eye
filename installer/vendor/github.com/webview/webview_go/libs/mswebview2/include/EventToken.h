// EventToken.h — Microsoft WebView2 SDK support header.
//
// Declares EventRegistrationToken, the opaque event-handler handle returned
// by every ICoreWebView2* add_* method and consumed by the matching
// remove_* method. This is the one symbol the WebView2 SDK header requires
// from EventToken.h; the file was dropped from the webview_go 0.10.0
// vendored SDK (upstream issue #21). The loader passes tokens through
// opaquely, so the handle is modeled as a 64-bit value.
//
// Origin: Microsoft WebView2 SDK (MIT-licensed; see WebView2.h header).
#ifndef EVENTTOKEN_H
#define EVENTTOKEN_H

#include <stdint.h>

typedef struct EventRegistrationToken {
	int64_t token;
} EventRegistrationToken;

#endif /* EVENTTOKEN_H */