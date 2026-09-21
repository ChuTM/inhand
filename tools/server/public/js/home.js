// Scroll-reveal: fade+rise sections as they enter the viewport.
// Honors prefers-reduced-motion (CSS already shows everything; JS just no-ops).
(function () {
  "use strict";
  var els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || !els.length) {
    els.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });
  els.forEach(function (el) { io.observe(el); });
})();

// Footer accordion — interaction copied from AlphaBrate: link columns collapse
// on narrow screens and expand by tapping the heading or click-holder.
(function () {
  "use strict";
  var cols = document.querySelectorAll(".footer > .rows > .cols > .col");
  if (!cols.length) return;

  function isNarrow() {
    return window.innerWidth < 630;
  }
  // Measure the natural (expanded) height, then collapse each column.
  function measure() {
    cols.forEach(function (col) {
      var wasShow = col.classList.contains("show");
      col.classList.remove("collapsed", "show");
      col.style.setProperty("--height", col.clientHeight - 24 + "px");
      col.classList.add("collapsed");
      if (wasShow && isNarrow()) col.classList.add("show");
    });
  }

  measure();
  window.addEventListener("resize", measure);

  document.querySelectorAll(
    ".footer > .rows > .cols > .col > .footer-heading, .footer > .rows > .cols > .col > .click-holder"
  ).forEach(function (el) {
    el.addEventListener("click", function () {
      if (isNarrow()) el.parentElement.classList.toggle("show");
    });
  });
})();

// Live version badge: keep the footer version in sync with the latest GitHub
// release (server proxies api.github.com via /api/version, same-origin fetch).
// Falls back to the static version in the HTML when unavailable.
(function () {
  "use strict";
  var badge = document.querySelector(".footer .col-version");
  if (!badge) return;
  fetch("/api/version", { headers: { Accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && d.version) {
        badge.textContent = /^v/i.test(d.version) ? d.version : "v" + d.version;
      }
    })
    .catch(function () { /* keep the static fallback */ });
})();
