import { Platform, setIcon, setTooltip } from "obsidian";

const MAXIMIZED_CLASS = "t7li-maximized";
const BUTTON_CLASS = "t7li-maximize";

/**
 * Add a toggle that makes a modal fill the app window, placed just left of the modal's
 * close button. Phones get none: modals already fill the screen there. Works on any
 * `.modal` element, including ones another plugin opened (DOM and CSS only).
 */
export function addMaximizeButton(
	modalEl: HTMLElement,
	startMaximized: boolean,
	onToggle?: (maximized: boolean) => void,
): void {
	if (
		Platform.isPhone ||
		modalEl.querySelector(`:scope > .${BUTTON_CLASS}`)
	) {
		return;
	}
	const button = modalEl.createDiv({
		cls: `${BUTTON_CLASS} clickable-icon`,
		attr: { role: "button", tabindex: "0" },
	});
	const apply = (maximized: boolean): void => {
		modalEl.toggleClass(MAXIMIZED_CLASS, maximized);
		setIcon(button, maximized ? "minimize-2" : "maximize-2");
		const label = maximized ? "Restore size" : "Fill the window";
		button.setAttr("aria-label", label);
		setTooltip(button, label);
	};
	const toggle = (): void => {
		const maximized = !modalEl.hasClass(MAXIMIZED_CLASS);
		apply(maximized);
		onToggle?.(maximized);
	};
	button.addEventListener("click", toggle);
	button.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggle();
		}
	});
	apply(startMaximized);
	// Line up with the close button once laid out; CSS has a fallback position.
	window.requestAnimationFrame(() => {
		const close = modalEl.querySelector<HTMLElement>(".modal-close-button");
		if (!close) {
			return;
		}
		const modalRect = modalEl.getBoundingClientRect();
		const closeRect = close.getBoundingClientRect();
		button.setCssProps({
			"--t7li-maximize-top": `${closeRect.top - modalRect.top}px`,
			"--t7li-maximize-right": `${modalRect.right - closeRect.left + 4}px`,
		});
	});
}

/**
 * Call `onModal` for every modal opened later in the same document (stacked on top),
 * until the returned function is called. Suggestion pickers are not `.modal` and are
 * skipped.
 */
export function watchStackedModals(
	anchor: HTMLElement,
	onModal: (modalEl: HTMLElement) => void,
): () => void {
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of Array.from(record.addedNodes)) {
				if (
					!node.instanceOf(HTMLElement) ||
					!node.hasClass("modal-container")
				) {
					continue;
				}
				const modal =
					node.querySelector<HTMLElement>(":scope > .modal");
				if (modal) {
					onModal(modal);
				}
			}
		}
	});
	observer.observe(anchor.ownerDocument.body, { childList: true });
	return () => observer.disconnect();
}
