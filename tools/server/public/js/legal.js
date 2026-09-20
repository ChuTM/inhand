/**
 * legal.js — in-page section indicator (scrollspy) for /legal/:slug pages.
 *
 * Tracks the section currently in view, highlights it in the right-hand
 * contents list, and reports reading progress (whole page + mobile bar).
 * Pure progressive enhancement: without JS the indicator stays a static
 * clickable contents list and every anchor still works.
 */
(function () {
	"use strict";

	var root = document.getElementById("sec-indicator");
	if (!root) return;

	var items = Array.prototype.slice.call(root.querySelectorAll(".toc-item"));
	if (!items.length) return;

	var currentLabel = document.getElementById("si-current");
	var progressPct = document.getElementById("si-progress");
	var trackFill = document.getElementById("si-track-fill");
	var mobileFill = document.getElementById("si-mobile-fill");

	var headings = items
		.map(function (item) {
			return document.getElementById(item.getAttribute("data-target"));
		})
		.filter(Boolean);

	if (!headings.length) return;

	var ticking = false;
	var lastActive = -999;

	function onScroll() {
		if (!ticking) {
			ticking = true;
			window.requestAnimationFrame(update);
		}
	}

	// Only called when the active section actually changes — this is what
	// makes the blur / offset / expansion transitions play smoothly instead
	// of being re-set every scroll frame and restarted mid-flight.
	function applyActive(active) {
		lastActive = active;

		for (var j = 0; j < items.length; j++) {
			items[j].classList.toggle("active", j === active);
		}
		// Progressive blur: sharp at the active section, fading + blurring
		// with distance.
		for (var b = 0; b < items.length; b++) {
			var link = items[b].querySelector("a");
			if (!link) continue;
			var dist = Math.abs(b - active);
			if (dist === 0) {
				link.style.filter = "blur(0px)";
				link.style.opacity = "1";
				link.style.transform = "translateX(0px)";
			} else {
				var blur = Math.min(dist * 0.3, 1.4);
				var op = Math.max(1 - dist * 0.1, 0.5);
				var off = Math.min(dist * 5, 20);
				link.style.filter = "blur(" + blur.toFixed(2) + "px)";
				link.style.opacity = op.toFixed(2);
				link.style.transform = "translateX(" + off.toFixed(1) + "px)";
			}
		}
		// Sub-sections expand once their chapter has been reached.
		var chapterVisited = false;
		for (var k = 0; k < items.length; k++) {
			var isSub = items[k].classList.contains("lvl-3");
			if (!isSub) {
				chapterVisited = k <= active;
			} else {
				items[k].classList.toggle("expanded", chapterVisited);
			}
		}
		// Update the label and re-centre the list on the active item.
		var label = items[active].querySelector(".toc-label");
		if (label && currentLabel) currentLabel.textContent = label.textContent;
		var list = root.querySelector(".si-list");
		var activeItem = items[active];
		if (list && activeItem) {
			var lr = list.getBoundingClientRect();
			var ar = activeItem.getBoundingClientRect();
			// Smoothly glide the list so the new active section settles in the
			// middle — not a hard jump.
			var target = list.scrollTop + ar.top - lr.top - (lr.height - ar.height) / 2;
			list.scrollTo({ top: target, behavior: "smooth" });
		}
	}

	function update() {
		ticking = false;

		// The active section is the last heading whose top has passed the
		// middle of the viewport — a section counts as "entered" once it
		// crosses the 50% line of the screen.
		var readLine = window.scrollY + window.innerHeight * 0.5;
		var active = -1;
		for (var i = 0; i < headings.length; i++) {
			if (headings[i].getBoundingClientRect().top + window.scrollY <= readLine) {
				active = i;
			}
		}
		// At the very bottom of the page the final section is active.
		if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
			active = headings.length - 1;
		}
		// At the very top nothing has passed the read line yet — default to
		// the first section so the rail is never empty on load.
		if (active < 0) active = 0;

		// Only re-paint the rail when the section actually changes.
		if (active !== lastActive) applyActive(active);

		// Reading progress updates every frame (it is a progress bar).
		var max = document.documentElement.scrollHeight - window.innerHeight;
		var pct = max > 0 ? Math.min(100, Math.round((window.scrollY / max) * 100)) : 0;
		if (progressPct) progressPct.textContent = pct + "%";
		if (trackFill) trackFill.style.width = pct + "%";
		if (mobileFill) mobileFill.style.width = pct + "%";
	}

	window.addEventListener("scroll", onScroll, { passive: true });
	window.addEventListener("resize", onScroll, { passive: true });
	update();
})();
