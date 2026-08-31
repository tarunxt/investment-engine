"use client";

import { useEffect } from "react";

const ENHANCED_ATTR = "data-bullpen008-collapsible";
const TRIGGER_ATTR = "data-bullpen008-collapse-trigger";
const COLLAPSE_ALL_ATTR = "data-bullpen008-collapse-all";
const COLLAPSED_ATTR = "data-bullpen008-collapsed";
const STAGE_DIALOG_PATTERN = /^Stage\s+[1-6]:/i;

function directChildren(element: Element) {
  return Array.from(element.children) as HTMLElement[];
}

function directHeader(root: HTMLElement) {
  return (root.firstElementChild as HTMLElement | null) ?? null;
}

function sectionLabel(root: HTMLElement, header: HTMLElement) {
  const heading = header.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6");
  const text = heading?.textContent?.trim() || root.getAttribute("aria-label") || "section";
  return text.replace(/\s+/g, " ");
}

function makeTrigger(label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(TRIGGER_ATTR, "true");
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-label", `Collapse ${label}`);
  button.title = `Collapse ${label}`;
  button.textContent = "▴";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "24px";
  button.style.height = "24px";
  button.style.flex = "0 0 auto";
  button.style.border = "1px solid rgb(203 213 225)";
  button.style.borderRadius = "9999px";
  button.style.background = "white";
  button.style.color = "rgb(71 85 105)";
  button.style.fontSize = "12px";
  button.style.fontWeight = "700";
  button.style.lineHeight = "1";
  button.style.cursor = "pointer";
  button.style.boxShadow = "0 1px 2px rgb(15 23 42 / 0.04)";
  return button;
}

function setExpanded(root: HTMLElement, expanded: boolean) {
  const trigger = root.querySelector<HTMLElement>(`:scope > * [${TRIGGER_ATTR}], :scope > [${TRIGGER_ATTR}]`);
  const kind = root.dataset.bullpen008CollapsibleKind;

  if (kind === "table-row") {
    const cells = directChildren(root);
    const labelCell = cells[0] as HTMLTableCellElement | undefined;
    const valueCell = cells[1] as HTMLTableCellElement | undefined;
    if (labelCell && valueCell) {
      valueCell.hidden = !expanded;
      if (expanded) {
        labelCell.removeAttribute("colspan");
      } else {
        labelCell.colSpan = 2;
      }
    }
  } else {
    const header = directHeader(root);
    if (header) {
      for (const child of directChildren(root).slice(1)) {
        child.hidden = !expanded;
      }
    }
    root.style.padding = expanded ? "" : "8px 12px";
  }

  root.setAttribute(COLLAPSED_ATTR, expanded ? "false" : "true");
  if (trigger) {
    const label = root.dataset.bullpen008CollapseLabel || "section";
    const triangle = expanded ? "▴" : "▾";
    if (trigger.textContent !== triangle) trigger.textContent = triangle;
    trigger.setAttribute("aria-expanded", expanded ? "true" : "false");
    trigger.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${label}`);
    trigger.setAttribute("title", `${expanded ? "Collapse" : "Expand"} ${label}`);
  }
}

function enhanceBlock(root: HTMLElement, kind: "section" | "record-card") {
  if (root.hasAttribute(ENHANCED_ATTR)) return;
  const header = directHeader(root);
  const children = directChildren(root);
  if (!header || children.length < 2) return;

  const heading = header.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6");
  if (!heading?.textContent?.trim()) return;

  const label = sectionLabel(root, header);
  const trigger = makeTrigger(label);
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setExpanded(root, root.getAttribute(COLLAPSED_ATTR) === "true");
    updateCollapseAllButton(root.closest<HTMLElement>('[role="dialog"]'));
  });

  header.appendChild(trigger);
  root.setAttribute(ENHANCED_ATTR, "true");
  root.dataset.bullpen008CollapsibleKind = kind;
  root.dataset.bullpen008CollapseLabel = label;
  setExpanded(root, true);
}

function looksLikeComplexTableRow(row: HTMLTableRowElement) {
  const cells = directChildren(row);
  if (cells.length !== 2 || cells[0].tagName !== "TH" || cells[1].tagName !== "TD") return false;
  const valueCell = cells[1];
  return Boolean(
    valueCell.querySelector("table") ||
      valueCell.querySelector('[class*="rounded-2xl"][class*="border"]') ||
      valueCell.querySelector('[class*="space-y-3"], [class*="space-y-4"]'),
  );
}

function enhanceTableRow(row: HTMLTableRowElement) {
  if (row.hasAttribute(ENHANCED_ATTR) || !looksLikeComplexTableRow(row)) return;
  const cells = directChildren(row);
  const labelCell = cells[0] as HTMLTableCellElement;
  const label = labelCell.textContent?.trim().replace(/\s+/g, " ") || "section";
  const trigger = makeTrigger(label);
  trigger.style.marginLeft = "8px";
  trigger.style.verticalAlign = "middle";
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setExpanded(row, row.getAttribute(COLLAPSED_ATTR) === "true");
    updateCollapseAllButton(row.closest<HTMLElement>('[role="dialog"]'));
  });
  labelCell.appendChild(trigger);
  row.setAttribute(ENHANCED_ATTR, "true");
  row.dataset.bullpen008CollapsibleKind = "table-row";
  row.dataset.bullpen008CollapseLabel = label;
  setExpanded(row, true);
}

function isStructuredRecordCard(element: HTMLElement) {
  if (!element.matches('div[class*="rounded-2xl"][class*="border"]')) return false;
  const header = directHeader(element);
  if (!header || !header.matches('div[class*="flex"]')) return false;
  const heading = header.querySelector<HTMLElement>("p");
  return Boolean(
    heading?.textContent?.trim() &&
      /\b(?:\d+|event\s+\d+)\b/i.test(heading.textContent) &&
      directChildren(element).length > 1,
  );
}

function isRecordDetailsCard(element: HTMLElement) {
  if (!element.matches('div[class*="rounded-3xl"][class*="border"]')) return false;
  const header = directHeader(element);
  return Boolean(header?.querySelector("h4") && directChildren(element).length > 1);
}

function isBullpen008StageDialog(dialog: HTMLElement) {
  const ariaLabel = dialog.getAttribute("aria-label")?.trim() || "";
  if (!STAGE_DIALOG_PATTERN.test(ariaLabel)) return false;
  const headerText = dialog.firstElementChild?.textContent || dialog.textContent || "";
  return /Bullpen\s*008/i.test(headerText.slice(0, 1200));
}

function collapsibles(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(`[${ENHANCED_ATTR}]`));
}

function updateCollapseAllButton(dialog: HTMLElement | null) {
  if (!dialog) return;
  const button = dialog.querySelector<HTMLButtonElement>(`button[${COLLAPSE_ALL_ATTR}]`);
  if (!button) return;
  const items = collapsibles(dialog);
  const details = Array.from(dialog.querySelectorAll<HTMLDetailsElement>("details"));
  const anyExpanded = items.some((item) => item.getAttribute(COLLAPSED_ATTR) !== "true") || details.some((item) => item.open);
  const nextText = anyExpanded ? "Collapse All" : "Expand All";
  if (button.textContent !== nextText) button.textContent = nextText;
  button.setAttribute("aria-label", anyExpanded ? "Collapse all popup sections" : "Expand all popup sections");
  button.title = anyExpanded ? "Collapse every section and subsection" : "Expand every section and subsection";
}

function addCollapseAllButton(dialog: HTMLElement) {
  if (dialog.querySelector(`button[${COLLAPSE_ALL_ATTR}]`)) return;
  const header = dialog.firstElementChild as HTMLElement | null;
  if (!header) return;
  const closeButton = Array.from(header.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    /close/i.test(button.getAttribute("aria-label") || ""),
  );
  if (!closeButton) return;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(COLLAPSE_ALL_ATTR, "true");
  button.textContent = "Collapse All";
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.minHeight = "36px";
  button.style.padding = "0 12px";
  button.style.marginLeft = "auto";
  button.style.marginRight = "8px";
  button.style.border = "1px solid rgb(186 230 253)";
  button.style.borderRadius = "9999px";
  button.style.background = "rgb(240 249 255)";
  button.style.color = "rgb(3 105 161)";
  button.style.fontSize = "12px";
  button.style.fontWeight = "700";
  button.style.cursor = "pointer";
  button.style.whiteSpace = "nowrap";
  button.addEventListener("click", () => {
    const shouldExpand = button.textContent === "Expand All";
    for (const item of collapsibles(dialog)) setExpanded(item, shouldExpand);
    for (const details of Array.from(dialog.querySelectorAll<HTMLDetailsElement>("details"))) {
      details.open = shouldExpand;
    }
    updateCollapseAllButton(dialog);
  });

  closeButton.parentElement?.insertBefore(button, closeButton);
  updateCollapseAllButton(dialog);
}

function enhanceDialog(dialog: HTMLElement) {
  if (!isBullpen008StageDialog(dialog)) return;

  for (const section of Array.from(dialog.querySelectorAll<HTMLElement>("section"))) {
    enhanceBlock(section, "section");
  }

  for (const card of Array.from(dialog.querySelectorAll<HTMLElement>('div[class*="rounded-2xl"], div[class*="rounded-3xl"]'))) {
    if (isStructuredRecordCard(card) || isRecordDetailsCard(card)) {
      enhanceBlock(card, "record-card");
    }
  }

  for (const row of Array.from(dialog.querySelectorAll<HTMLTableRowElement>("tbody > tr"))) {
    enhanceTableRow(row);
  }

  for (const details of Array.from(dialog.querySelectorAll<HTMLDetailsElement>("details"))) {
    if (details.dataset.bullpen008DetailsObserved === "true") continue;
    details.dataset.bullpen008DetailsObserved = "true";
    details.addEventListener("toggle", () => updateCollapseAllButton(dialog));
  }

  addCollapseAllButton(dialog);
  updateCollapseAllButton(dialog);
}

function enhanceVisibleDialogs() {
  for (const dialog of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))) {
    enhanceDialog(dialog);
  }
}

export function Bullpen008StageDialogCollapseEnhancer() {
  useEffect(() => {
    enhanceVisibleDialogs();
    const observer = new MutationObserver(() => enhanceVisibleDialogs());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
