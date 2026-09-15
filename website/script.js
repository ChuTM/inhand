// Raw Markdown Document Content
fetch("./markdown/quick_download.md")
	.then((response) => response.text())
	.then((markdown) => {
		const markdownSource = markdown.replace(/\r\n/g, "\n"); // Normalize line breaks

		// Custom parser logic to handle container components (:::cmd and :::info)
		function parseCustomBlocks(markdown) {
			// Match :::cmd [Title] \n [Content] \n :::
			let processed = markdown.replace(
				/:::cmd ([^\n]+)\n([\s\S]*?)\n:::/g,
				function (match, title, code) {
					let cleanCode = code
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;");

					// Parse ___placeholder___ tags
					cleanCode = cleanCode.replace(
						/___([\s\S]*?)___/g,
						function (placeholderMatch, placeholderText) {
							const initialLength = placeholderText.length;

							return `<input type='text' 
                        placeholder='${placeholderText}' 
                        class='url-input' 
                        data-default='${placeholderText}'
                        size='${initialLength}' />`;
						},
					);

					return `
<div class="block-container">
    <div class="block-header">
        <span class="block-title">Command: ${title}</span>
        <div class="copy-trigger" onclick="copy(this)"><i class="fa-regular fa-copy"></i></div>
    </div>
    <pre><code>${cleanCode}</code></pre>
</div>`;
				},
			);

			// Match :::info [Title] \n [Content] \n :::
			processed = processed.replace(
				/:::info ([^\n]+)\n([\s\S]*?)\n:::/g,
				function (match, title, content) {
					return `
<div class="info-card">
    <i class="fa-solid fa-circle-info" style="margin-top: 3px;"></i>
    <span><strong>${title}:</strong> ${marked.parseInline(content)}</span>
</div>`;
				},
			);

			return processed;
		}
		// Render compilation pipeline
		const targetedMarkdown = parseCustomBlocks(markdownSource);
		document.getElementById("content").innerHTML =
			marked.parse(targetedMarkdown);

		document.querySelectorAll(".url-input").forEach((input) => {
			input.addEventListener("input", function () {
				this.size = Math.max(
					this.value.length,
					this.getAttribute("data-default").length,
				);

				this.value = this.value.trim(); // Trim whitespace
				const rules = [
					["https://", ""],
					["http://", ""],
					["./", "wallpg.web.app/"],
				];

				// Find the first rule whose prefix matches the input
				const match = rules.find(([prefix]) =>
					this.value.startsWith(prefix),
				);

				if (match) {
					const [prefix, replacement] = match;
					this.value = replacement + this.value.slice(prefix.length);
				}
			});
		});
	});

function copy(el) {
	const pre = el.parentElement.nextElementSibling;
	let textToCopy = "";

	const inputField = pre.querySelector(".url-input");

	if (inputField) {
		const clonedPre = pre.cloneNode(true);
		const clonedInput = clonedPre.querySelector(".url-input");

		// Use user text if present; fall back to data-default if blank
		const dynamicValue =
			clonedInput.value.trim() !== ""
				? clonedInput.value
				: clonedInput.getAttribute("data-default");

		clonedInput.replaceWith(dynamicValue);
		textToCopy = clonedPre.innerText;
	} else {
		textToCopy = pre.innerText;
	}

	navigator.clipboard.writeText(textToCopy);

	// Visual feedback success indicator
	const icon = el.querySelector("i");
	icon.className = "fa-solid fa-check";
	el.classList.add("success");

	setTimeout(() => {
		icon.className = "fa-regular fa-copy";
		el.classList.remove("success");
	}, 2000);
}
