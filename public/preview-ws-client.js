/**
 * The previewed page's `WebSocket`.
 *
 * Injected into every HTML document the preview serves (ADR-0033). It exists because a previewed page is a document in another realm: it cannot
 * reach the container's own `WebSocket`, and a service worker never sees a handshake, so nothing underneath it can route one.
 *
 * Deliberately plumbing, like `preview-sw.js`: the risky decisions (which URLs may open, what a legal close code is) belong to the shell and are
 * made in `src/browser/socket-relay.ts`, where tests can reach them. This file only has to be a faithful `WebSocket` for the page's own code:
 * the four ready states, `open`/`message`/`error`/`close`, `send`, `close`, `binaryType`, `protocol`, and the same order of events a browser
 * gives. Everything visible here should behave the way `vite`'s HMR client expects, because that client is the first real user.
 */
(function () {
  "use strict";

  var CONNECTING = 0;
  var OPEN = 1;
  var CLOSING = 2;
  var CLOSED = 3;

  var nextId = 1;
  var sockets = new Map();

  function parentOrigin() {
    return window.location.origin;
  }

  function post(message) {
    // Same origin both ways: the preview frame is served from the shell's own origin, and anything else is not the shell talking.
    window.parent.postMessage(message, parentOrigin());
  }

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return null;
  }

  function PreviewWebSocket(url, protocols) {
    if (!(this instanceof PreviewWebSocket)) throw new TypeError("Failed to construct 'WebSocket': call with new.");
    if (window.parent === window) throw new Error("A preview websocket only works inside the preview frame.");

    var absolute;
    try {
      absolute = new URL(String(url), window.location.href).href;
    } catch (error) {
      throw new SyntaxError("Failed to construct 'WebSocket': not a URL: " + String(url));
    }

    var requested = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : Array.prototype.slice.call(protocols);
    requested.forEach(function (entry) {
      if (typeof entry !== "string" || entry.length === 0) throw new SyntaxError("Failed to construct 'WebSocket': invalid protocol.");
    });

    this.url = absolute;
    this.readyState = CONNECTING;
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.extensions = "";
    this.protocol = "";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    var id = nextId++;
    this._swcId = id;
    sockets.set(id, this);
    post({ type: "socket-open", id: id, url: absolute, protocols: requested });
  }

  PreviewWebSocket.prototype._listeners = null;

  Object.defineProperties(PreviewWebSocket, {
    CONNECTING: { value: CONNECTING },
    OPEN: { value: OPEN },
    CLOSING: { value: CLOSING },
    CLOSED: { value: CLOSED },
  });
  Object.defineProperties(PreviewWebSocket.prototype, {
    CONNECTING: { value: CONNECTING },
    OPEN: { value: OPEN },
    CLOSING: { value: CLOSING },
    CLOSED: { value: CLOSED },
  });

  PreviewWebSocket.prototype.addEventListener = function (type, listener) {
    if (listener === null || listener === undefined) return;
    if (this._listeners === null) this._listeners = new Map();
    var set = this._listeners.get(type);
    if (set === undefined) {
      set = [];
      this._listeners.set(type, set);
    }
    if (set.indexOf(listener) === -1) set.push(listener);
  };

  PreviewWebSocket.prototype.removeEventListener = function (type, listener) {
    if (this._listeners === null) return;
    var set = this._listeners.get(type);
    if (set === undefined) return;
    var at = set.indexOf(listener);
    if (at !== -1) set.splice(at, 1);
  };

  PreviewWebSocket.prototype.dispatchEvent = function (event) {
    // The `on<type>` property runs before the listeners added with `addEventListener`, which is the order a browser uses and the order code
    // that mixes the two styles relies on.
    var handler = this["on" + event.type];
    if (typeof handler === "function") handler.call(this, event);
    var set = this._listeners === null ? undefined : this._listeners.get(event.type);
    if (set !== undefined) {
      // Copied: a listener that removes itself (the common `{ once: true }` pattern) must not shorten the list being walked.
      set.slice().forEach(function (listener) {
        listener.call(this, event);
      }, this);
    }
    return true;
  };

  PreviewWebSocket.prototype._emit = function (event) {
    this.dispatchEvent(event);
  };

  PreviewWebSocket.prototype.send = function (data) {
    if (this.readyState === CONNECTING) {
      throw new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    }
    if (this.readyState !== OPEN) return; // A browser discards a send after close rather than throwing.
    if (typeof data === "string") {
      post({ type: "socket-send", id: this._swcId, text: data });
      return;
    }
    var bytes = toBytes(data);
    if (bytes === null) throw new TypeError("Failed to execute 'send' on 'WebSocket': not a string, ArrayBuffer or view.");
    post({ type: "socket-send", id: this._swcId, body: bytes });
  };

  PreviewWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    var closing = code === undefined ? 1000 : code;
    var why = reason === undefined ? "" : String(reason);
    if (closing !== 1000 && (closing < 3000 || closing > 4999)) {
      throw new Error("Failed to execute 'close' on 'WebSocket': the code must be 1000 or 3000-4999.");
    }
    if (new TextEncoder().encode(why).length > 123) {
      throw new Error("Failed to execute 'close' on 'WebSocket': the reason is limited to 123 bytes.");
    }
    this.readyState = CLOSING;
    post({ type: "socket-close", id: this._swcId, code: closing, reason: why });
  };

  function deliver(message) {
    var socket = sockets.get(message.id);
    if (socket === undefined) return;

    if (message.type === "socket-opened") {
      socket.protocol = message.protocol || "";
      socket.readyState = OPEN;
      socket._emit(new Event("open"));
      return;
    }

    if (message.type === "socket-data") {
      if (socket.readyState !== OPEN) return;
      var data;
      if (typeof message.text === "string") {
        data = message.text;
      } else {
        // The bytes may arrive as a view or as a bare buffer depending on how far they travelled, and a page that set `binaryType` to
        // "arraybuffer" must get an ArrayBuffer either way. Guessing wrong here is the difference between binary frames working and a TypeError
        // inside the page's handler.
        var raw = message.body;
        var view;
        if (raw instanceof ArrayBuffer) view = new Uint8Array(raw);
        else if (raw && raw.buffer) view = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength || 0);
        else if (raw instanceof Blob) {
          // A Blob is legal for a browser but cannot be turned into bytes synchronously, so it is delivered as the Blob it is when that is what the
          // page asked for, and otherwise refused rather than silently delivered as zero bytes.
          if (socket.binaryType !== "blob") return;
          view = null;
        } else return;
        data = view === null ? raw : socket.binaryType === "arraybuffer" ? view.slice().buffer : new Blob([view]);
      }
      socket._emit(new MessageEvent("message", { data: data, origin: parentOrigin() }));
      return;
    }

    var failed = message.type === "socket-failed";
    var closeCode = failed ? 1006 : message.code;
    var closeReason = failed ? String(message.message || "") : String(message.reason || "");
    sockets.delete(message.id);
    socket.readyState = CLOSED;
    if (failed) {
      // A connection that never opened gets `error` and then `close`, which is what a browser does and what HMR's reconnect logic expects.
      socket._emit(new Event("error"));
    }
    socket._emit(new CloseEvent("close", { code: closeCode, reason: closeReason, wasClean: !failed && message.clean === true }));
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== parentOrigin() || event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    if (message.type.indexOf("socket-") !== 0) return;
    deliver(message);
  });

  window.WebSocket = PreviewWebSocket;
  window.__swcPreviewWebSocket = true;
})();
