/**
 * Inspector bridge injected into served report HTML.
 *
 * The report renders inside a sandboxed iframe (`allow-scripts`, no
 * `allow-same-origin`), so the parent viewer cannot touch the iframe DOM.
 * This bridge runs inside the iframe, tracks hover/click, builds a unique CSS
 * selector + text fingerprint for the targeted element, and reports geometry to
 * the parent via `postMessage`. The parent draws the hover highlight and
 * re-resolves existing comment pins onto their owning elements.
 */
const BRIDGE_MARKER = "data-pagelet-bridge";

const INSPECTOR_BRIDGE_SOURCE = String.raw`
(function () {
  if (window.__pageletInspectorBridge) return;
  window.__pageletInspectorBridge = true;
  var inspecting = false;
  var lastHoverEl = null;

  function esc(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }
  function isStableClass(cls) {
    if (/^(is-|js-|has-|active|selected|hover|focus|open|closed|show|hide|disabled|current)$/i.test(cls)) return false;
    if (/[0-9]{5,}/.test(cls)) return false;
    return true;
  }
  function isUnique(root, sel, el) {
    try { var m = root.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch (e) { return false; }
  }
  function nthOfType(node) {
    var n = 1, cur = node.previousElementSibling;
    while (cur) { if (cur.tagName === node.tagName) n++; cur = cur.previousElementSibling; }
    return n;
  }
  function buildSelector(el, root) {
    if (!el || el === root || el.nodeType !== 1) return null;
    if (el.id && isUnique(root, "#" + esc(el.id), el)) return "#" + esc(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== root) {
      var part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        var classes = Array.prototype.filter.call(node.classList, isStableClass);
        if (classes.length) part += "." + classes.map(esc).join(".");
      }
      var candidate = parts.length ? parts.join(" > ") + " > " + part : part;
      if (isUnique(root, candidate, el)) { parts.unshift(part); break; }
      if (isUnique(root, part, el)) return part;
      part += ":nth-of-type(" + nthOfType(node) + ")";
      parts.unshift(part);
      node = node.parentElement;
    }
    var sel = parts.join(" > ");
    return isUnique(root, sel, el) ? sel : null;
  }
  function normalizedText(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }
  // Hash of the leading text, used to detect that anchored content changed.
  function textFingerprint(text) {
    var t = text.slice(0, 120);
    if (!t) return "";
    var h = 0;
    for (var i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
    return t.length + ":" + (h >>> 0).toString(16);
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  function clamp(v) { return Math.max(0, Math.min(100, Number(v.toFixed(2)))); }
  function docInfo() {
    var de = document.documentElement;
    var body = document.body;
    return {
      scroll: { x: window.scrollX || de.scrollLeft || 0, y: window.scrollY || de.scrollTop || 0 },
      doc: {
        w: Math.max(de.scrollWidth, body ? body.scrollWidth : 0) || 1,
        h: Math.max(de.scrollHeight, body ? body.scrollHeight : 0) || 1
      },
      view: { w: window.innerWidth, h: window.innerHeight }
    };
  }
  function anchorFor(el) {
    var r = rectOf(el);
    var info = docInfo();
    var text = normalizedText(el);
    return {
      xPct: clamp(((r.x + info.scroll.x) / info.doc.w) * 100),
      yPct: clamp(((r.y + info.scroll.y) / info.doc.h) * 100),
      documentWidth: info.doc.w,
      documentHeight: info.doc.h,
      viewportWidth: info.view.w,
      viewportHeight: info.view.h,
      scrollX: info.scroll.x,
      scrollY: info.scroll.y,
      selector: buildSelector(el, document.body) || undefined,
      textFingerprint: textFingerprint(text) || undefined,
      // The agent needs the words, not the hash, to locate and edit the node.
      quotedText: text.slice(0, 300) || undefined
    };
  }
  function post(msg) { msg.source = "pagelet-bridge"; parent.postMessage(msg, "*"); }
  function setInspecting(next) {
    inspecting = !!next;
    document.documentElement.style.cursor = inspecting ? "crosshair" : "";
    if (document.body) document.body.style.cursor = inspecting ? "crosshair" : "";
    if (!inspecting) { lastHoverEl = null; post({ type: "hover-end" }); }
  }
  function shouldIgnore(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    var r = el.getBoundingClientRect();
    return r.width < 4 || r.height < 4;
  }

  document.addEventListener("mouseover", function (e) {
    if (!inspecting) return;
    var el = e.target;
    if (el === lastHoverEl || shouldIgnore(el)) return;
    lastHoverEl = el;
    post({ type: "hover", rect: rectOf(el), selector: buildSelector(el, document.body), tagName: el.tagName.toLowerCase() });
  }, true);
  document.addEventListener("mouseout", function (e) {
    if (!inspecting) return;
    if (!e.relatedTarget) { lastHoverEl = null; post({ type: "hover-end" }); }
  }, true);

  // A selection, when there is one, beats the element under the cursor: the
  // exact sentence is what the agent can find and change, where an element can
  // be a wrapper holding half the page.
  function selectionAnchor() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var selected = sel.toString().replace(/\s+/g, " ").trim();
    if (!selected) return null;
    var range = sel.getRangeAt(0);
    var host = range.commonAncestorContainer;
    if (host.nodeType === 3) host = host.parentElement;
    if (!host || host === document.documentElement) return null;
    var rect = range.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return null;
    var anchor = anchorFor(host);
    var info = docInfo();
    return {
      anchor: {
        ...anchor,
        xPct: clamp(((rect.left + info.scroll.x) / info.doc.w) * 100),
        yPct: clamp(((rect.top + info.scroll.y) / info.doc.h) * 100),
        textFingerprint: textFingerprint(selected) || undefined,
        quotedText: selected.slice(0, 300)
      },
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    };
  }

  document.addEventListener("click", function (e) {
    if (!inspecting) return;
    e.preventDefault();
    e.stopPropagation();
    var fromSelection = selectionAnchor();
    if (fromSelection) {
      post({ type: "select", anchor: fromSelection.anchor, rect: fromSelection.rect });
      return;
    }
    var el = e.target;
    if (shouldIgnore(el)) return;
    post({ type: "select", anchor: anchorFor(el), rect: rectOf(el) });
  }, true);

  // Selecting text is a drag, not a click, so mouseup is where a selection
  // becomes available without the user having to click again.
  document.addEventListener("mouseup", function () {
    if (!inspecting) return;
    var fromSelection = selectionAnchor();
    if (fromSelection) {
      post({ type: "select", anchor: fromSelection.anchor, rect: fromSelection.rect });
    }
  }, true);

  function notifyScrolled() { post({ type: "scroll" }); }
  window.addEventListener("scroll", notifyScrolled, true);
  window.addEventListener("resize", notifyScrolled);
  if (window.MutationObserver) {
    new MutationObserver(function () { notifyScrolled(); })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }

  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "pagelet-mode") {
      setInspecting(data.inspecting);
    } else if (data.type === "pagelet-resolve-all") {
      var anchors = data.anchors || [];
      post({
        type: "resolved",
        requestId: data.requestId,
        results: anchors.map(function (a, i) {
          if (!a || !a.selector) return { index: i, rect: null };
          try { var el = document.querySelector(a.selector); if (el) return { index: i, rect: rectOf(el) }; } catch (err) {}
          return { index: i, rect: null };
        })
      });
    }
  });

  post({ type: "ready" });
})();
`;

export function injectRenderBridge(html: string): string {
  if (html.includes(BRIDGE_MARKER)) {
    return html;
  }

  const script = `<script ${BRIDGE_MARKER}>${INSPECTOR_BRIDGE_SOURCE}</script>`;

  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}$&`);
  }

  return `${html}${script}`;
}
