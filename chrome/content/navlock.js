"use strict";

var NavLock = (function() {

  /*
   * Per-tab state is stored in a WeakMap keyed by the <browser> XUL element.
   * Each value is an object: { prefix: String|null, redirecting: Boolean }
   *
   * prefix === null  →  tab is unlocked (no interception)
   * prefix === ""    →  should not happen (we normalise "" to null)
   *
   * We also keep a parallel Map (browser → listener object) so we can
   * remove the nsIWebProgress listener when the tab is closed or we unlock.
   */

  // WeakMap: browser element → { prefix, redirecting }
  var _tabState    = new WeakMap();
  // Map: browser element → attached listener object (strong ref needed for removal)
  var _tabListener = new Map();

  /* ── prefs (global defaults only – per-tab state is in-memory) ──────── */
  var _prefs = Components.classes["@mozilla.org/preferences-service;1"]
                         .getService(Components.interfaces.nsIPrefBranch);

  function _getPrefStr(k)   { return _prefs.getCharPref(k); }
  function _getPrefBool(k)  { return _prefs.getBoolPref(k); }

  /* ── URL matching ───────────────────────────────────────────────────── */
  function _isAllowed(url, prefix) {
    // prefix is already normalised (no trailing slash)
    return url === prefix            ||
           url.indexOf(prefix + "/") === 0 ||
           url.indexOf(prefix + "?") === 0 ||
           url.indexOf(prefix + "#") === 0;
  }

  function _normalisePrefix(raw) {
    if (!raw) return null;
    return raw.replace(/\/+$/, "");   // strip trailing slashes
  }

  /* ── notification bar ───────────────────────────────────────────────── */
  function _showNotification(browser, msg) {
    var nb = gBrowser.getNotificationBox(browser);
    // Don't stack duplicate notifications
    if (nb.getNotificationWithValue("navlock-blocked")) return;
    nb.appendNotification(
      msg,
      "navlock-blocked",
      null,
      nb.PRIORITY_WARNING_MEDIUM,
      null
    );
  }

  /* ── per-browser progress listener factory ──────────────────────────── */
  function _makeListener(browser) {
    return {
      QueryInterface: function(aIID) {
        if (aIID.equals(Components.interfaces.nsIWebProgressListener)      ||
            aIID.equals(Components.interfaces.nsISupportsWeakReference)    ||
            aIID.equals(Components.interfaces.nsISupports))
          return this;
        throw Components.results.NS_ERROR_NO_INTERFACE;
      },

      onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
        var iWPL = Components.interfaces.nsIWebProgressListener;
        if (!(aStateFlags & iWPL.STATE_START))       return;
        if (!(aStateFlags & iWPL.STATE_IS_DOCUMENT)) return;
        if (!aWebProgress.isTopLevel)                return;

        var state = _tabState.get(browser);
        if (!state || state.prefix === null) return;  // tab not locked
        if (state.redirecting)              return;   // our own redirect

        var uri;
        try {
          uri = aRequest.QueryInterface(
                  Components.interfaces.nsIChannel).URI;
        } catch(e) { return; }

        var url = uri.spec;
        if (!/^https?:\/\//i.test(url)) return;      // let non-http through
        if (_isAllowed(url, state.prefix)) return;   // within allowed prefix

        // ── Violation ───────────────────────────────────────────────────
        aRequest.cancel(Components.results.NS_BINDING_ABORTED);

        var mode = _getPrefStr("extensions.navlock.mode");
        // snapshot these before the async timeout fires
        var prefix    = state.prefix;
        var theBrowser = browser;

        state.redirecting = true;
        window.setTimeout(function() {
          var s = _tabState.get(theBrowser);
          if (s) s.redirecting = false;

          if (mode === "redirect") {
            theBrowser.loadURI(prefix);
          } else {
            //theBrowser.loadURI("about:blank");
            _showNotification(theBrowser,
                "NavLock blocked navigation to: " + url);
          }
        }, 50);
      },

      onLocationChange:    function() {},
      onProgressChange:    function() {},
      onStatusChange:      function() {},
      onSecurityChange:    function() {},
      onLinkIconAvailable: function() {}
    };
  }

  /* ── attach / detach per-tab listener ──────────────────────────────── */
  var _WP_NOTIFY =
        Components.interfaces.nsIWebProgress.NOTIFY_STATE_DOCUMENT;

  function _attachListener(browser) {
    if (_tabListener.has(browser)) return;   // already attached
    var listener = _makeListener(browser);
    browser.webProgress.addProgressListener(listener, _WP_NOTIFY);
    _tabListener.set(browser, listener);
  }

  function _detachListener(browser) {
    var listener = _tabListener.get(browser);
    if (!listener) return;
    try { browser.webProgress.removeProgressListener(listener); } catch(e) {}
    _tabListener.delete(browser);
  }

  /* ── lock / unlock a specific browser element ───────────────────────── */
  function _lockBrowser(browser, prefix) {
    // prefix already normalised (or null to unlock)
    _tabState.set(browser, { prefix: prefix, redirecting: false });
    if (prefix !== null) {
      _attachListener(browser);
    } else {
      _detachListener(browser);
    }
  }

  /* ── button visual state (reflects current tab) ─────────────────────── */
  function _updateButton() {
    var btn = document.getElementById("navlock-button");
    if (!btn) return;
    var browser = gBrowser.selectedBrowser;
    var state   = _tabState.get(browser);
    var locked  = state && state.prefix !== null;
    btn.setAttribute("navlock-active", locked ? "true" : "false");
    var tip = locked
        ? "NavLock ON — locked to: " + state.prefix +
          "  |  left-click to configure, right-click to unlock"
        : "NavLock OFF — right-click to lock to current URL, left-click to configure";
    btn.setAttribute("tooltiptext", tip);
  }

  /* ── tab event handlers ─────────────────────────────────────────────── */
  var _tabSelectHandler = function() { _updateButton(); };

  var _tabCloseHandler = function(evt) {
    // evt.target is the <tab> element; get its browser
    var tab     = evt.target;
    var browser = gBrowser.getBrowserForTab(tab);
    if (!browser) return;
    _detachListener(browser);
    _tabState.delete(browser);   // WeakMap.delete is fine even if absent
  };

  /* ── public API ─────────────────────────────────────────────────────── */
  return {

    _init: function() {
      gBrowser.tabContainer.addEventListener("TabSelect", _tabSelectHandler, false);
      gBrowser.tabContainer.addEventListener("TabClose",  _tabCloseHandler,  false);
      _updateButton();
    },

    _shutdown: function() {
      gBrowser.tabContainer.removeEventListener("TabSelect", _tabSelectHandler, false);
      gBrowser.tabContainer.removeEventListener("TabClose",  _tabCloseHandler,  false);
      // Detach all listeners we still hold
      _tabListener.forEach(function(listener, browser) {
        try { browser.webProgress.removeProgressListener(listener); } catch(e) {}
      });
      _tabListener.clear();
    },

    /*
     * Toggle the current tab.
     * If locking: seed prefix from the current URL (user may then open the
     * dialog to adjust it).
     * If unlocking: remove the entry.
     */
    toggle: function() {
      var browser = gBrowser.selectedBrowser;
      var state   = _tabState.get(browser);
      var locked  = state && state.prefix !== null;

      if (locked) {
        _lockBrowser(browser, null);   // unlock
      } else {
        // Lock: seed from current URL
        var url    = gBrowser.currentURI.spec;
        var prefix = _normalisePrefix(url) || "about:blank";
        _lockBrowser(browser, prefix);
      }
      _updateButton();
    },

    /*
     * Open the config dialog for the current tab.
     * The dialog reads/writes directly to _tabState via the out-arg object.
     */
    openDialog: function() {
      var browser = gBrowser.selectedBrowser;
      var state   = _tabState.get(browser);
      var args    = {
        prefix:  (state && state.prefix !== null) ? state.prefix : "",
        locked:  !!(state && state.prefix !== null),
        mode:    _getPrefStr("extensions.navlock.mode"),
        // dialog writes back here:
        result:  null
      };

      window.openDialog(
        "chrome://navlock/content/dialog.xul",
        "navlock-config",
        "chrome,centerscreen,modal",
        args
      );

      if (args.result) {
        // Save global mode pref
        _prefs.setCharPref("extensions.navlock.mode", args.result.mode);

        var newPrefix = _normalisePrefix(args.result.prefix);
        if (!args.result.locked) newPrefix = null;
        _lockBrowser(browser, newPrefix);
      }
      _updateButton();
    },

    /* Exposed for dialog.xul's onLoad to read current state */
    getStateForCurrentTab: function() {
      // not used – dialog receives args object instead
    }
  };

})();

window.addEventListener("load",   function() { NavLock._init(); },     false);
window.addEventListener("unload", function() { NavLock._shutdown(); }, false);
