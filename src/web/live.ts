export const LIVE_SCRIPT_PATH = "/assets/live.js";

/**
 * Refreshes a page that follows live state by fetching it again and swapping
 * in only the regions that changed, so the scroll positions of the page and
 * of the sidebar, open menus, and a field being typed in survive. The page's
 * script tag names the address to fetch and the delay; each fetched page
 * names them again, and a page without the tag ends the polling. Without
 * scripts the page falls back to a meta refresh.
 */
export const LIVE_SCRIPT = `(function () {
  var SELECTOR = "script[data-live-seconds]";
  var REGIONS = ["main", "side"];
  var tag = document.querySelector(SELECTOR);
  if (!tag) return;
  var delay = 0;
  var target = "";

  function read(from) {
    delay = Math.max(1, Number(from.getAttribute("data-live-seconds")) || 5) * 1000;
    target = from.getAttribute("data-live-url") || location.href;
  }

  function busy() {
    var el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    if (document.querySelector("dialog[open]")) return true;
    try {
      return !!document.querySelector(":popover-open");
    } catch (e) {
      return false;
    }
  }

  function swap(region, next) {
    var open = [];
    var before = region.querySelectorAll("details");
    for (var i = 0; i < before.length; i++) if (before[i].open) open.push(i);
    var top = region.scrollTop;
    region.innerHTML = next.innerHTML;
    var after = region.querySelectorAll("details");
    for (var j = 0; j < open.length; j++) if (after[open[j]]) after[open[j]].open = true;
    region.scrollTop = top;
  }

  function show(doc) {
    var x = window.scrollX;
    var y = window.scrollY;
    for (var i = 0; i < REGIONS.length; i++) {
      var region = document.getElementById(REGIONS[i]);
      var next = doc.getElementById(REGIONS[i]);
      if (region && next && region.innerHTML !== next.innerHTML) swap(region, next);
    }
    window.scrollTo(x, y);
  }

  function again() {
    setTimeout(poll, delay);
  }

  function poll() {
    if (document.hidden || busy()) return again();
    var url = new URL(target, location.href);
    fetch(url.href, { credentials: "same-origin", cache: "no-store" })
      .then(function (response) {
        if (response.redirected && new URL(response.url).pathname !== url.pathname) {
          location.reload();
          return;
        }
        if (!response.ok) return again();
        return response.text().then(function (text) {
          var doc = new DOMParser().parseFromString(text, "text/html");
          if (!doc.getElementById("main")) return again();
          if (busy()) return again();
          show(doc);
          if (url.href !== location.href && history.replaceState) {
            history.replaceState(null, "", url.pathname + url.search + url.hash);
          }
          var next = doc.querySelector(SELECTOR);
          if (!next) return;
          read(next);
          again();
        });
      })
      .catch(again);
  }

  read(tag);
  again();
})();
`;
