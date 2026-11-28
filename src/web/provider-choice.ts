export const PROVIDER_CHOICE_SCRIPT_PATH = "/assets/provider-choice.js";

/** The tag the Models tab carries so a row's choices follow its provider. */
export const PROVIDER_CHOICE_SCRIPT_TAG = `<script src="${PROVIDER_CHOICE_SCRIPT_PATH}" defer></script>`;

/**
 * When a row's provider selector (`data-provider`) changes, shows only the new provider's
 * options in each selector of that row marked `data-follows-provider`. Each option names its
 * provider in `data-for`; an option without one is the placeholder. A chosen value the new
 * provider also offers, such as an effort level both have, stays chosen. Any other choice is
 * cleared to the placeholder, which is disabled, so a required selector asks for a new pick and
 * an effort is left unset. The placeholder takes the selector's `data-placeholder` text, or
 * `data-placeholder-none` when the provider offers nothing there. Without scripts every row
 * keeps the choices it was rendered with, and the server refuses a mismatch.
 */
export const PROVIDER_CHOICE_SCRIPT = `(function () {
  function follow(select, provider) {
    var value = select.value;
    var same = -1;
    var any = false;
    for (var i = 0; i < select.options.length; i++) {
      var option = select.options[i];
      var group = option.getAttribute("data-for");
      if (group === null) continue;
      var on = group === provider;
      option.hidden = !on;
      option.disabled = !on;
      if (!on) continue;
      any = true;
      if (same === -1 && value !== "" && option.value === value) same = i;
    }
    select.selectedIndex = same === -1 ? 0 : same;
    var first = select.options[0];
    var text = select.getAttribute(any ? "data-placeholder" : "data-placeholder-none");
    if (first && first.getAttribute("data-for") === null && text !== null) first.textContent = text;
  }

  document.addEventListener("change", function (event) {
    var select = event.target;
    if (!select || !select.hasAttribute || !select.hasAttribute("data-provider")) return;
    var row = select.closest ? select.closest("[data-provider-row]") : null;
    if (!row) return;
    var follows = row.querySelectorAll("select[data-follows-provider]");
    for (var i = 0; i < follows.length; i++) follow(follows[i], select.value);
  });
})();
`;
