export const LAZY_SCRIPT_PATH = "/assets/lazy.js";

/** The tag a page carries to load a slow section after the page itself has rendered. */
export const LAZY_SCRIPT_TAG = `<script src="${LAZY_SCRIPT_PATH}" defer></script>`;

/**
 * Fills each element that has a `data-lazy-url` with the HTML fragment that
 * address answers, so a page can render at once and a slow read finishes while
 * the owner is already on it. The last fragment is kept in sessionStorage and
 * shown at once on the next visit while a fresh one loads, so moving between
 * tabs does not show an empty section. A failed load shows an error inside the
 * section with a Retry button, and leaves a kept fragment in place. A button
 * with `data-lazy-refresh` asks the server to read again. A script tag with
 * `data-lazy-forget` drops the kept fragment for that address, for a page that
 * saves what the fragment shows. Without storage or scripts the page still works.
 */
export const LAZY_SCRIPT = `(function () {
  var PREFIX = "hephaestus-lazy:";

  function storage() {
    try {
      return window.sessionStorage;
    } catch (e) {
      return null;
    }
  }

  function keep(url, html) {
    try {
      var store = storage();
      if (store) store.setItem(PREFIX + url, html);
    } catch (e) {
      // A full or blocked store only costs the cache.
    }
  }

  function kept(url) {
    try {
      var store = storage();
      return store ? store.getItem(PREFIX + url) : null;
    } catch (e) {
      return null;
    }
  }

  function forget(url) {
    try {
      var store = storage();
      if (store) store.removeItem(PREFIX + url);
    } catch (e) {
      // Nothing was kept.
    }
  }

  var forgetTag = document.querySelector("script[data-lazy-forget]");
  if (forgetTag) forget(forgetTag.getAttribute("data-lazy-forget"));

  var nodes = document.querySelectorAll("[data-lazy-url]");

  function load(node, refresh) {
    var url = node.getAttribute("data-lazy-url");
    var shown = node.getAttribute("data-lazy-state") === "shown";
    node.setAttribute("aria-busy", "true");
    fetch(refresh ? url + "?refresh=1" : url, { credentials: "same-origin", cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + String(response.status));
        return response.text();
      })
      .then(function (html) {
        node.innerHTML = html;
        node.setAttribute("data-lazy-state", "shown");
        keep(url, html);
      })
      .catch(function () {
        if (!shown) {
          node.innerHTML = '<span class="muted">Could not load this.</span> <button type="button" data-lazy-retry>Retry</button>';
        }
      })
      .then(function () {
        node.setAttribute("aria-busy", "false");
      });
  }

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var old = kept(node.getAttribute("data-lazy-url"));
    if (old !== null) {
      node.innerHTML = old;
      node.setAttribute("data-lazy-state", "shown");
    }
    load(node, false);
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var refresh = target.closest("[data-lazy-refresh]");
    var retry = target.closest("[data-lazy-retry]");
    var button = refresh || retry;
    var holder = button && button.closest("[data-lazy-url]");
    if (holder) load(holder, !!refresh);
  });
})();
`;
