"""Browser DOM snapshot and stable element ref protocol.

Extracts visible interactive DOM elements into lightweight textual representation
and maintains stable element references (refs) for token-economic browser interaction.
Based on community reference implementation for DOM snapshot and ref management.
"""
from __future__ import annotations

import json
from typing import List, Dict, Optional, Any

DOM_SNAPSHOT_JS = """(() => {
  const MAX_ELEMENTS = 120;
  const interactiveSelectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(interactiveSelectors));
  const results = [];

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function getCssSelector(el) {
    if (el.id) {
      return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
    }
    const name = el.getAttribute('name');
    const tag = el.tagName.toLowerCase();
    if (name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      return tag + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    }
    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement) {
      let selector = curr.tagName.toLowerCase();
      if (curr.id) {
        parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(curr.id) : curr.id.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')));
        break;
      }
      let sibling = curr;
      let nth = 1;
      while (sibling = sibling.previousElementSibling) {
        if (sibling.tagName === curr.tagName) nth++;
      }
      selector += ':nth-of-type(' + nth + ')';
      parts.unshift(selector);
      curr = curr.parentElement;
    }
    return parts.join(' > ');
  }

  let count = 0;
  for (const el of nodes) {
    if (count >= MAX_ELEMENTS) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'svg') continue;
    if (!isVisible(el)) continue;

    count++;
    const ref = 'e' + count;
    const role = el.getAttribute('role') || '';
    let text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    const placeholder = (el.getAttribute('placeholder') || '').slice(0, 40);
    const ariaLabel = (el.getAttribute('aria-label') || '').slice(0, 40);
    const val = (el.value !== undefined && el.value !== null ? String(el.value) : '').slice(0, 30);
    const rect = el.getBoundingClientRect();
    const enabled = !el.disabled && !el.getAttribute('aria-disabled');
    const selector = getCssSelector(el);

    results.push({
      ref: ref,
      tag: tag,
      role: role,
      text: text,
      placeholder: placeholder,
      ariaLabel: ariaLabel,
      value: val,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      enabled: Boolean(enabled),
      selector: selector,
    });
  }
  return results;
})()"""


class RefRegistry:
    """Manages mappings from stable element refs ('e12') to CSS selectors per tab."""

    def __init__(self):
        self._tabs: Dict[str, Dict[str, str]] = {}
        self._meta: Dict[str, Dict[str, Dict[str, Any]]] = {}

    def register(self, tab_id: str, elements: List[Dict[str, Any]]) -> Dict[str, str]:
        """Register elements for a tab and record ref -> selector mappings."""
        tab_map: Dict[str, str] = {}
        meta_map: Dict[str, Dict[str, Any]] = {}
        for el in elements:
            ref = el.get("ref")
            selector = el.get("selector")
            if ref and selector:
                tab_map[ref] = selector
                meta_map[ref] = el
        self._tabs[tab_id] = tab_map
        self._meta[tab_id] = meta_map
        return tab_map

    def resolve(self, tab_id: str, ref: str) -> Optional[str]:
        """Resolve an element ref to its CSS selector for a given tab."""
        return self._tabs.get(tab_id, {}).get(ref)

    def get_element(self, tab_id: str, ref: str) -> Optional[Dict[str, Any]]:
        """Retrieve cached element metadata for an element ref."""
        return self._meta.get(tab_id, {}).get(ref)

    def invalidate(self, tab_id: str) -> None:
        """Invalidate all element refs for a tab (called upon navigation/reload)."""
        self._tabs.pop(tab_id, None)
        self._meta.pop(tab_id, None)

    def clear(self) -> None:
        """Clear all registered tab refs."""
        self._tabs.clear()
        self._meta.clear()


_shared_ref_registry = RefRegistry()


def get_ref_registry() -> RefRegistry:
    """Access the global singleton RefRegistry."""
    return _shared_ref_registry


def render_compact(elements: List[Dict[str, Any]], max_chars: int = 4000) -> str:
    """Format interactive elements into a concise token-economic text representation.

    Example line:
    [e1] button "Submit" (enabled)
    """
    if not elements:
        return "(No interactive elements found on page)"

    lines = []
    for el in elements:
        ref = el.get("ref", "e?")
        tag = el.get("tag", "")
        role = el.get("role", "")
        text = el.get("text", "")
        placeholder = el.get("placeholder", "")
        aria = el.get("ariaLabel", "")
        val = el.get("value", "")
        enabled = el.get("enabled", True)
        status = "enabled" if enabled else "disabled"

        tag_desc = tag
        redundant_roles = {
            "a": "link",
            "button": "button",
            "select": "combobox",
            "textarea": "textbox",
        }
        if role and role.lower() != tag.lower() and redundant_roles.get(tag.lower()) != role.lower():
            tag_desc += f" [role={role}]"

        details = []
        if text:
            details.append(f'"{text}"')
        if placeholder:
            details.append(f'placeholder="{placeholder}"')
        if aria and aria != text:
            details.append(f'aria="{aria}"')
        if val:
            details.append(f'value="{val}"')

        detail_str = " ".join(details)
        line = f"[{ref}] {tag_desc}" + (f" {detail_str}" if detail_str else "") + f" ({status})"
        lines.append(line)

    rendered = "\n".join(lines)
    if len(rendered) > max_chars:
        rendered = rendered[: max_chars - 35] + "\n...(remaining elements truncated)"
    return rendered

