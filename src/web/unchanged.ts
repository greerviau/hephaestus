export const UNCHANGED_SCRIPT_PATH = "/assets/unchanged.js";

/** The tag every dashboard page carries, so a save button waits until its form has a change. */
export const UNCHANGED_SCRIPT_TAG = `<script src="${UNCHANGED_SCRIPT_PATH}" defer></script>`;

/**
 * Turns off each button that has `data-unchanged` while its form still holds
 * the values the page was rendered with, and shows the attribute's text as its
 * tooltip. Saving then would create a config version with no changes. Fields
 * named in `data-unchanged-ignore`, such as Deploy now and the message, do not
 * count, since they change nothing in the config. The comparison is with the
 * values in the page's HTML rather than the ones the browser shows at load, so
 * a form the browser refilled after a reload still counts as changed. Without
 * scripts the button stays on, and the server answers an unchanged save.
 */
export const UNCHANGED_SCRIPT = `(function () {
  function fieldState(field, rendered) {
    var type = field.type;
    if (type === "checkbox" || type === "radio") {
      return (rendered ? field.defaultChecked : field.checked) ? field.value : "";
    }
    if (field.options && (type === "select-one" || type === "select-multiple")) {
      var picked = [];
      for (var i = 0; i < field.options.length; i++) {
        var option = field.options[i];
        if (rendered ? option.defaultSelected : option.selected) picked.push(option.value);
      }
      return picked.join("\\n");
    }
    return rendered ? field.defaultValue : field.value;
  }

  function formState(form, ignored, rendered) {
    var parts = [];
    for (var i = 0; i < form.elements.length; i++) {
      var field = form.elements[i];
      if (!field.name || field.disabled || ignored.indexOf(field.name) !== -1) continue;
      if (field.type === "submit" || field.type === "button" || field.type === "reset") continue;
      parts.push(field.name + "=" + fieldState(field, rendered));
    }
    return JSON.stringify(parts);
  }

  function watch(button) {
    var form = button.form;
    if (!form) return;
    var why = button.getAttribute("data-unchanged");
    var ignored = (button.getAttribute("data-unchanged-ignore") || "").split(" ");
    var ownTitle = button.getAttribute("title");
    var rendered = formState(form, ignored, true);

    function check() {
      var same = formState(form, ignored, false) === rendered;
      button.disabled = same;
      if (same) button.setAttribute("title", why);
      else if (ownTitle === null) button.removeAttribute("title");
      else button.setAttribute("title", ownTitle);
    }

    form.addEventListener("input", check);
    form.addEventListener("change", check);
    window.addEventListener("pageshow", check);
    check();
  }

  var buttons = document.querySelectorAll("button[data-unchanged]");
  for (var i = 0; i < buttons.length; i++) watch(buttons[i]);
})();
`;
