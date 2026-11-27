export const PENDING_SCRIPT_PATH = "/assets/pending.js";

/** The tag every dashboard page carries, so each button that posts shows at once that it was pressed. */
export const PENDING_SCRIPT_TAG = `<script src="${PENDING_SCRIPT_PATH}" defer></script>`;

/**
 * Shows that a POST form was sent: the pressed button gets the `pending` class
 * and the form `aria-busy` as soon as it submits, so a slow answer does not
 * look like a click that never landed. Its buttons are disabled once the
 * browser has read the form, since disabling the pressed button earlier would
 * drop its name and value from the request, and a second submission of the
 * same form is refused until then. A page the browser restores from its cache
 * gets its buttons back. The listener sits on the document, so forms a live
 * refresh swaps in work too. Without scripts the forms work as before.
 */
export const PENDING_SCRIPT = `(function () {
  var MARK = "data-pending";
  var BUTTONS = 'button[type="submit"], button:not([type]), input[type="submit"]';

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || form.tagName !== "FORM" || event.defaultPrevented) return;
    if ((form.getAttribute("method") || "").toLowerCase() !== "post") return;
    if (form.hasAttribute(MARK)) {
      event.preventDefault();
      return;
    }
    form.setAttribute(MARK, "");
    form.setAttribute("aria-busy", "true");
    var buttons = form.querySelectorAll(BUTTONS);
    var pressed = event.submitter || buttons[0];
    if (pressed) pressed.classList.add("pending");
    // A button the page itself disabled stays disabled when the page comes back.
    var held = [];
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].disabled) continue;
      buttons[i].setAttribute(MARK, "");
      buttons[i].setAttribute("aria-disabled", "true");
      held.push(buttons[i]);
    }
    setTimeout(function () {
      for (var j = 0; j < held.length; j++) held[j].disabled = true;
    }, 0);
  });

  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    var forms = document.querySelectorAll("form[" + MARK + "]");
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      form.removeAttribute(MARK);
      form.removeAttribute("aria-busy");
      var buttons = form.querySelectorAll(BUTTONS);
      for (var j = 0; j < buttons.length; j++) {
        if (!buttons[j].hasAttribute(MARK)) continue;
        buttons[j].removeAttribute(MARK);
        buttons[j].disabled = false;
        buttons[j].removeAttribute("aria-disabled");
        buttons[j].classList.remove("pending");
      }
    }
  });
})();
`;
