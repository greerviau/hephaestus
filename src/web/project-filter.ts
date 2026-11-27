export const PROJECT_FILTER_SCRIPT_PATH = "/assets/project-filter.js";

/** The tag the sidebar carries so that picking a project applies it at once. */
export const PROJECT_FILTER_SCRIPT_TAG = `<script src="${PROJECT_FILTER_SCRIPT_PATH}" defer></script>`;

/**
 * Submits the form of a select marked `data-submit-on-change` as soon as its
 * value changes, so the sidebar's project picker needs no Apply button. The
 * select is disabled once its form is sent: the page is leaving, and a second
 * request could reach the server after the first and leave the older choice
 * in the cookie. A page the browser restores from its cache gets the select
 * back. The listener sits on the document, so a picker a live refresh swaps
 * in works too. Without scripts the picker keeps its Apply button.
 */
export const PROJECT_FILTER_SCRIPT = `(function () {
  var MARK = "data-submit-on-change";

  document.addEventListener("change", function (event) {
    var select = event.target;
    if (!select || !select.hasAttribute || !select.hasAttribute(MARK)) return;
    if (select.disabled || !select.form) return;
    if (select.form.requestSubmit) select.form.requestSubmit();
    else select.form.submit();
    // The form's fields are read when it is submitted, so disabling it now keeps the value sent.
    select.disabled = true;
  });

  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    var selects = document.querySelectorAll("select[" + MARK + "]");
    for (var i = 0; i < selects.length; i += 1) selects[i].disabled = false;
  });
})();
`;
