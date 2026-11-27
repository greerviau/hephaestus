export const CHART_TIP_SCRIPT_PATH = "/assets/chart-tip.js";

/** The tag a page with charts carries so that hovering a chart shows its numbers. */
export const CHART_TIP_SCRIPT_TAG = `<script src="${CHART_TIP_SCRIPT_PATH}" defer></script>`;

/**
 * Shows a tip beside the pointer while it is over an element with a
 * `data-tip`. The attribute's first line is the tip's heading and each later
 * line is a row. The text goes in with textContent, so nothing in it can run
 * as markup. The tip sits on the far side of the pointer when the near side
 * would leave the window, and never past the window's top or left edge.
 * Listeners sit on the document, so charts a live refresh swaps in work too.
 * Without scripts the folded table still holds every number.
 */
export const CHART_TIP_SCRIPT = `(function () {
  var GAP = 12;
  var EDGE = 8;
  var tip = null;
  var current = null;

  function element() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function place(x, y) {
    var node = element();
    var width = node.offsetWidth;
    var height = node.offsetHeight;
    var left = x + GAP;
    if (left + width > window.innerWidth - EDGE) left = x - GAP - width;
    var top = y + GAP;
    if (top + height > window.innerHeight - EDGE) top = y - GAP - height;
    node.style.left = String(Math.max(EDGE, left)) + "px";
    node.style.top = String(Math.max(EDGE, top)) + "px";
  }

  function show(target, x, y) {
    var node = element();
    if (target !== current) {
      current = target;
      var lines = (target.getAttribute("data-tip") || "").split("\\n");
      node.replaceChildren();
      lines.forEach(function (text, index) {
        var row = document.createElement(index === 0 ? "b" : "div");
        row.textContent = text;
        node.appendChild(row);
      });
    }
    node.hidden = false;
    place(x, y);
  }

  function hide() {
    current = null;
    if (tip) tip.hidden = true;
  }

  function hit(event) {
    var target = event.target;
    return target && target.closest ? target.closest("[data-tip]") : null;
  }

  document.addEventListener("pointerover", function (event) {
    var target = hit(event);
    if (target) show(target, event.clientX, event.clientY);
  });
  document.addEventListener("pointermove", function (event) {
    var target = hit(event);
    if (target) show(target, event.clientX, event.clientY);
  });
  document.addEventListener("pointerout", function (event) {
    var target = hit(event);
    if (target && target === current && !target.contains(event.relatedTarget)) hide();
  });
  document.addEventListener("scroll", hide, true);
})();
`;
